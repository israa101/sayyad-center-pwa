/**
 * db.js
 * -------------------------------------------------------------
 * IndexedDB wrapper for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Stores:
 *   - "students"   master roster, cached from API. Offline-created students
 *                  carry syncStatus:'pending_creation' until pushed.
 *   - "records"    attendance + grades entries. Status lifecycle:
 *                      "draft"    → Present clicked; timestamp captured.
 *                      "pending"  → إرسال للاعتماد clicked; grades attached.
 *                      "approved" → approved by admin; queued for API push.
 *                      "synced"   → successfully pushed to API.
 *                      "failed"   → approved but API push failed; will retry.
 *   - "settings"   dropdown option lists (branches, years, days, times).
 *   - "meta"       small key/value operational data (last sync time).
 *
 * NOTE: "secretaries" store has been REMOVED (Change #1 — single admin user).
 *       PIN authentication is now handled via a hardcoded value; no DB store needed.
 *
 * Falls back to an in-memory + localStorage shim if IndexedDB is unavailable.
 * -------------------------------------------------------------
 */

const DB_NAME    = 'sayyad_center_db';
const DB_VERSION = 3;               // bumped from 2 to trigger onupgradeneeded

const STORE_STUDENTS = 'students';
const STORE_RECORDS  = 'records';
const STORE_META     = 'meta';
const STORE_SETTINGS = 'settings';

class SayyadDB {
  constructor() {
    this._db          = null;
    this._ready       = null;
    this._useFallback = false;
    this._fallbackData = {
      students: [],
      records:  [],
      meta:     {},
      settings: [],
    };
  }

  /* ------------------------------------------------------------ */
  /* Initialization                                                */
  /* ------------------------------------------------------------ */

  init() {
    if (this._ready) return this._ready;

    this._ready = new Promise((resolve) => {
      if (!('indexedDB' in window)) {
        console.warn('[SayyadDB] IndexedDB غير متاح — تفعيل التخزين البديل.');
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        console.warn('[SayyadDB] فشل فتح IndexedDB.', err);
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
        return;
      }

      request.onupgradeneeded = (event) => {
        const db      = event.target.result;
        const oldVer  = event.oldVersion;

        /* Students store */
        if (!db.objectStoreNames.contains(STORE_STUDENTS)) {
          const ss = db.createObjectStore(STORE_STUDENTS, { keyPath: 'id' });
          ss.createIndex('name',  'name',  { unique: false });
          ss.createIndex('group', 'group', { unique: false });
          ss.createIndex('year',  'year',  { unique: false });
        }

        /* Records store */
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const rs = db.createObjectStore(STORE_RECORDS, { keyPath: 'recordId' });
          rs.createIndex('studentId', 'studentId', { unique: false });
          rs.createIndex('status',    'status',    { unique: false });
          rs.createIndex('createdAt', 'createdAt', { unique: false });
          rs.createIndex('dateKey',   'dateKey',   { unique: false });
        }

        /* Meta store */
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }

        /* Settings store */
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }

        /* ── REMOVED: secretaries store (Change #1) ──
         * If upgrading from v2, drop the old store to keep things clean. */
        if (oldVer < 3 && db.objectStoreNames.contains('secretaries')) {
          db.deleteObjectStore('secretaries');
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;

        // *** FIX (App Freeze on Upgrade): لو تاب/نسخة تانية من التطبيق
        // (أو الـ service worker) عندها اتصال قديم مفتوح، وحصل bump في
        // DB_VERSION، الاتصال الحالي ده هيستقبل 'versionchange' — نقفله
        // ونعمل reload صامت عشان الاتصال الجديد يقدر يفتح من غير ما
        // يستني (يبلوك) على الاتصال القديم.
        this._db.onversionchange = () => {
          this._db.close();
          window.location.reload();
        };

        resolve();
      };

      // *** FIX (App Freeze on Upgrade): لو فيه اتصال قديم متعلق (blocked)
      // ومنع الـ upgrade من الاستمرار، الـ request مش هيوصل لا لـ onsuccess
      // ولا onerror — هيفضل عالق. الحل: نعمل reload يقفل التاب الحالي
      // ويفتح اتصال جديد بعد ما القديم يتقفل من مكان تاني.
      request.onblocked = () => {
        console.warn('[SayyadDB] IndexedDB upgrade blocked — إعادة تحميل الصفحة.');
        window.location.reload();
      };

      request.onerror = (event) => {
        console.warn('[SayyadDB] خطأ IndexedDB — تفعيل التخزين البديل.', event.target.error);
        this._useFallback = true;
        this._loadFallbackFromLocalStorage();
        resolve();
      };
    });

    return this._ready;
  }

  /* ------------------------------------------------------------ */
  /* Fallback (localStorage) helpers                               */
  /* ------------------------------------------------------------ */

  _loadFallbackFromLocalStorage() {
    try {
      const raw = localStorage.getItem('sayyad_fallback_db');
      if (raw) this._fallbackData = { ...this._fallbackData, ...JSON.parse(raw) };
    } catch (err) {
      console.warn('[SayyadDB] تعذّرت قراءة التخزين البديل', err);
    }
  }

  _persistFallback() {
    try {
      localStorage.setItem('sayyad_fallback_db', JSON.stringify(this._fallbackData));
    } catch (err) {
      console.warn('[SayyadDB] تعذّر حفظ التخزين البديل', err);
    }
  }

  /* ------------------------------------------------------------ */
  /* Low-level transaction helper                                  */
  /* ------------------------------------------------------------ */

  _tx(storeName, mode = 'readonly') {
    return this._db.transaction(storeName, mode).objectStore(storeName);
  }

  /* ================================================================
     STUDENTS
     ================================================================ */

  /**
   * Replace the full local roster with a fresh server copy.
   * Locally-created students still pending creation are preserved.
   */
  async replaceAllStudents(freshList) {
    await this.init();
    const existing    = await this.getAllStudents();
    const stillPending = existing.filter((s) => s.syncStatus === 'pending_creation');
    const merged      = [...freshList, ...stillPending];

    if (this._useFallback) {
      this._fallbackData.students = merged;
      this._persistFallback();
      return merged;
    }

    return new Promise((resolve, reject) => {
      const store    = this._tx(STORE_STUDENTS, 'readwrite');
      const clearReq = store.clear();
      clearReq.onsuccess = () => { merged.forEach((s) => store.put(s)); };
      const tx = store.transaction;
      tx.oncomplete = () => resolve(merged);
      tx.onerror    = () => reject(tx.error);
    });
  }

  async upsertStudent(student) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.students.findIndex((s) => s.id === student.id);
      if (idx >= 0) this._fallbackData.students[idx] = student;
      else          this._fallbackData.students.push(student);
      this._persistFallback();
      return student;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS, 'readwrite');
      const req   = store.put(student);
      req.onsuccess = () => resolve(student);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllStudents() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.students];
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async getStudent(id) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.students.find((s) => s.id === id) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_STUDENTS);
      const req   = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async getStudentsPendingCreation() {
    const all = await this.getAllStudents();
    return all.filter((s) => s.syncStatus === 'pending_creation');
  }

  /* ================================================================
     RECORDS
     ================================================================ */

  async upsertRecord(record) {
    await this.init();
    if (this._useFallback) {
      const idx = this._fallbackData.records.findIndex((r) => r.recordId === record.recordId);
      if (idx >= 0) this._fallbackData.records[idx] = record;
      else          this._fallbackData.records.push(record);
      this._persistFallback();
      return record;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS, 'readwrite');
      const req   = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllRecords() {
    await this.init();
    if (this._useFallback) return [...this._fallbackData.records];
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req   = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async getRecordsByStatus(status) {
    const all = await this.getAllRecords();
    return all.filter((r) => r.status === status);
  }

  /**
   * Returns today's record for a student that is NOT yet fully approved/synced.
   * Includes 'draft' and 'pending' so the two-step flow can continue from where
   * the user left off.
   */
  async getRecordByStudentToday(studentId, dateStr) {
    const all = await this.getAllRecords();
    return all.find(
      (r) => r.studentId === studentId &&
             r.dateKey   === dateStr   &&
             r.status    !== 'approved' &&
             r.status    !== 'synced'
    ) || null;
  }

  async getRecord(recordId) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.records.find((r) => r.recordId === recordId) || null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS);
      const req   = store.get(recordId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  /**
   * ترتيب مراحل السجل من الأقل اكتمالًا للأكثر — بيُستخدم في الدمج عشان
   * نقرر مين "أوفق" من التاني، بدل ما نفترض إن أي سجل سيرفر بمفتاح مختلف
   * لازم ياخد الأولوية.
   *   draft (0) < pending/failed (1) < approved (2) < synced (3)
   * failed معاملة زي pending لأنها برضه "لسه محتاجة اعتماد/رفع"، مش
   * تراجع عن أي تقدّم سابق.
   *
   * *** إضافة (Tombstone) *** 'removed' (طالب اتعلّم "غائب" صراحةً أثناء
   * تعديل الجلسة) معاملة بنفس رتبة 'approved' (2) — مش أعلى رتبة ثابتة.
   * السبب: "غائب" مش دايمًا لازم تكسب أي حضور تاني بشكل تلقائي — ممكن
   * حد يرجّع الطالب "حاضر" بعد كده عن قصد (سجل pending جديد)، ولازم
   * القرار الأحدث زمنيًا هو اللي يكسب، مش رتبة ثابتة. عشان كده التعارض
   * بين removed وأي حالة تانية بنفس الرتبة أو رتبة قريبة بيتحل بمقارنة
   * الوقت (updatedAt) في mergeServerRecord عن طريق _isNewerRecord، مش
   * بالاعتماد على هذه الدالة وحدها.
   */
  _recordRank(status) {
    switch (status) {
      case 'draft':    return 0;
      case 'pending':  return 1;
      case 'failed':   return 1;
      case 'approved': return 2;
      case 'removed':  return 2;
      case 'synced':   return 3;
      default:         return -1;
    }
  }

  /**
   * *** إضافة (Time-based tie-break) ***
   * بيقارن بين سجلين لهما نفس الرتبة (_recordRank) تقريبًا، عشان نحدد
   * مين "أحدث" فعليًا بالوقت — مستخدمة تحديدًا لحل تعارض 'removed' ضد
   * 'pending/approved/draft' بنفس الرتبة أو رتبة متقاربة، واللي مفيهاش
   * صح مطلق غير "مين اتاخد قراره بعد التاني؟". بترجع true لو candidate
   * (المرشح الجديد) أحدث فعليًا من current (المحلي/الموجود).
   * لو مفيش updatedAt واضح على أي الطرفين، نرجع للرتبة العادية كـ fallback.
   */
  _isNewerRecord(candidate, current) {
    const cRank = this._recordRank(candidate.status);
    const curRank = this._recordRank(current.status);

    // نلجأ لمقارنة الوقت فقط لما يكون فيه تنافس حقيقي بين 'removed'
    // (قرار غياب صريح) وأي حالة حضور فعلية تانية (draft/pending/approved/
    // synced) لنفس السجل أو نفس الطالب/اليوم — عشان القرار الأحدث زمنيًا
    // هو اللي يكسب في هذه الحالة تحديدًا، مش رتبة ثابتة.
    const isRemovedConflict =
      (candidate.status === 'removed') !== (current.status === 'removed');

    if (!isRemovedConflict) {
      return cRank > curRank;
    }

    const cTime   = candidate.updatedAt || candidate.createdAt || 0;
    const curTime = current.updatedAt   || current.createdAt   || 0;

    if (cTime === curTime) {
      // تعادل تام — سيب الرتبة العادية تحسم (removed=2 هتكسب draft/pending
      // بس تخسر approved/synced لو نفس الوقت بالظبط، حالة نادرة جدًا).
      return cRank > curRank;
    }
    return cTime > curTime;
  }

  /**
   * يرجّع أي سجل محلي (أيًا كانت حالته) لنفس الطالب في نفس اليوم.
   * ده المفتاح المنطقي للـ dedup: student_id + date_key وليس recordId،
   * لأن نفس الطالب ممكن يتسجّله جهازين مختلفين بـ recordId مختلف محليًا
   * قبل المزامنة.
   */
  async getRecordByStudentAndDate(studentId, dateKey) {
    const all = await this.getAllRecords();
    return all.find(
      (r) => String(r.studentId) === String(studentId) && r.dateKey === dateKey
    ) || null;
  }

  /**
   * دمج سجل قادم من Supabase (سيرفر) مع السجل المحلي لنفس الطالب/اليوم،
   * مع منع التكرار (نفس الطالب ميتعرضش مرتين في نفس اليوم) — من غير ما
   * نضيع تقدّم محلي أعلى مرحلة من اللي جاي من السيرفر.
   *
   * *** BUGFIX (مراجعة عميقة) ***
   * النسخة القديمة كانت بتمسح أي سجل محلي draft/pending/failed فورًا بمجرد
   * ما تلاقي سجل سيرفر مختلف الـ recordId لنفس الطالب/اليوم — حتى لو سجل
   * السيرفر ده كان لسه "pending" برضه (يعني نفس الشخص رفعه هو نفسه من
   * الجهاز ده أو من سباق بين جهازين). النتيجة: سجل "pending" المستخدم
   * اللي لسه بيستنى اعتماد الأدمن كان ممكن يتمسح فجأة في نص العملية.
   *
   * القاعدة الجديدة: السيرفر مايستبدلش المحلي إلا لو كان أوفق فعلًا
   * (rank أعلى). لو نفس المرحلة أو أقل، المحلي بيفضل زي ما هو (وبنسيب
   * upsert بمفتاح recordId العادي يتكفّل بأي تحديث تفصيلي لاحقًا لو
   * الـ recordId اتفق).
   *
   * قواعد الدمج:
   *  - مفيش سجل محلي أصلاً → أضف سجل السيرفر كما هو.
   *  - نفس recordId بالظبط → تحديث عادي (السيرفر أحدث نسخة لنفس السجل).
   *  - recordId مختلف، ورتبة سجل السيرفر أعلى من رتبة المحلي (مثلاً
   *    محلي draft/pending وسيرفر approved/synced لأن جهاز تاني خلّص
   *    الاعتماد) → امسح المحلي القديم وثبّت سجل السيرفر (منع تكرار).
   *  - recordId مختلف، ورتبة سجل السيرفر ≤ رتبة المحلي (مثلاً المحلي
   *    pending والسيرفر كمان pending/draft) → سيب المحلي زي ما هو؛
   *    منمسحش سجل لسه بيستنى اعتماد الأدمن.
   */
  async mergeServerRecord(serverRecord) {
    await this.init();
    const localMatch = await this.getRecordByStudentAndDate(serverRecord.studentId, serverRecord.dateKey);

    if (!localMatch) {
      return this.upsertRecord(serverRecord);
    }

    // نفس الـ recordId بالظبط.
    // *** BUGFIX (PULL قديم بيكتب فوق تقدّم محلي على نفس الـ recordId) ***
    // لو الـ sync بيعمل PULL قبل PUSH، ممكن السيرفر يرجّع نسخة "قديمة"
    // لنفس الـ recordId (مثلاً لسه pending) في حين إن المستخدم عمل
    // Approve محليًا فعلًا (status بقى approved) قبل ما الـ sync يشتغل.
    // الـ spread القديم { ...localMatch, ...serverRecord } كان بياخد
    // status دايمًا من serverRecord، فكان بيرجّع السجل المحلي المعتمد
    // لـ "pending" تاني غلط — لحظة ما الـ PULL يجيب النسخة القديمة قبل
    // ما الـ PUSH يوصل يحدّث السيرفر. الحل: نفس منطق الرتبة اللي بنستخدمه
    // في حالة الـ recordId المختلف.
    if (localMatch.recordId === serverRecord.recordId) {
      if (this._isNewerRecord(serverRecord, localMatch)) {
        // السيرفر أوفق/أحدث فعليًا (أو حالة مش معروفة) — آمن نحدّث بكل
        // بيانات السيرفر عادي.
        return this.upsertRecord({ ...localMatch, ...serverRecord });
      }

      // السيرفر أقدم/أقل تقدّمًا (نسخة قديمة رجعت بسبب الـ PULL قبل الـ
      // PUSH، أو تعارض removed اتحسم لصالح المحلي) — سيب status وتقدّم
      // المحلي زي ما هو، ودمج باقي الحقول الوصفية المفيدة من السيرفر.
      return this.upsertRecord({ ...localMatch, ...serverRecord, status: localMatch.status, updatedAt: localMatch.updatedAt });
    }

    // recordId مختلف لنفس الطالب/اليوم — قارن الأوفقية (رتبة + وقت) قبل
    // أي حذف.
    if (this._isNewerRecord(serverRecord, localMatch)) {
      // سجل السيرفر أوفق/أحدث فعلًا (مثلاً جهاز تاني اعتمد السجل، أو
      // قرار "غائب"/"حاضر" أحدث زمنيًا من جهاز تاني) — آمن نستبدل
      // المحلي الأقل أوفقية بيه.
      await this.deleteRecord(localMatch.recordId);
      return this.upsertRecord(serverRecord);
    }

    // سجل السيرفر أقدم/أقل أوفقية — ما نلمسش المحلي، عشان منمسحش سجل
    // "pending" (أو draft، أو حتى "removed" أحدث) المستخدم لسه شغال
    // عليه أو قرر فيه قرار أحدث.
    return localMatch;
  }

  async deleteRecord(recordId) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.records = this._fallbackData.records.filter((r) => r.recordId !== recordId);
      this._persistFallback();
      return true;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_RECORDS, 'readwrite');
      const req   = store.delete(recordId);
      req.onsuccess = () => resolve(true);
      req.onerror   = () => reject(req.error);
    });
  }

  async updateRecordStatus(recordId, status, extra = {}) {
    const record = await this.getRecord(recordId);
    if (!record) return null;
    const updated = { ...record, status, ...extra, updatedAt: Date.now() };
    return this.upsertRecord(updated);
  }

  /* ================================================================
     SETTINGS (branches, years, days, times)
     ================================================================ */

  async setSetting(key, value) {
    await this.init();
    if (this._useFallback) {
      const idx   = this._fallbackData.settings.findIndex((s) => s.key === key);
      const entry = { key, value };
      if (idx >= 0) this._fallbackData.settings[idx] = entry;
      else          this._fallbackData.settings.push(entry);
      this._persistFallback();
      return value;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS, 'readwrite');
      const req   = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror   = () => reject(req.error);
    });
  }

  async getSetting(key) {
    await this.init();
    if (this._useFallback) {
      const found = this._fallbackData.settings.find((s) => s.key === key);
      return found ? found.value : null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror   = () => reject(req.error);
    });
  }

  async getAllSettings() {
    await this.init();
    if (this._useFallback) {
      const obj = {};
      this._fallbackData.settings.forEach((s) => { obj[s.key] = s.value; });
      return obj;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_SETTINGS);
      const req   = store.getAll();
      req.onsuccess = () => {
        const obj = {};
        (req.result || []).forEach((s) => { obj[s.key] = s.value; });
        resolve(obj);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /* ================================================================
     META
     ================================================================ */

  async setMeta(key, value) {
    await this.init();
    if (this._useFallback) {
      this._fallbackData.meta[key] = value;
      this._persistFallback();
      return value;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_META, 'readwrite');
      const req   = store.put({ key, value });
      req.onsuccess = () => resolve(value);
      req.onerror   = () => reject(req.error);
    });
  }

  async getMeta(key) {
    await this.init();
    if (this._useFallback) {
      return this._fallbackData.meta[key] ?? null;
    }
    return new Promise((resolve, reject) => {
      const store = this._tx(STORE_META);
      const req   = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror   = () => reject(req.error);
    });
  }
}

// Singleton instance used across the app.
const db = new SayyadDB();