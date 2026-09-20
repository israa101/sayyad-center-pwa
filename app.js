/**
 * app.js
 * -------------------------------------------------------------
 * Core application logic for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Change #1 — Single Admin User & Static PIN:
 *   No secretaries store; PIN is hardcoded to ADMIN_PIN ('1234').
 *   Session persisted in localStorage (not secretaryId).
 *
 * Change #2 — Smart Student ID Generation by Branch + Year (Dynamic Ranges):
 *   Each branch (سنتر) owns a dedicated 200-number range, sub-divided
 *   internally per school stage/year. See buildDynamicRanges() below.
 *
 * Change #3 — Two-Step Quick Attendance (no غائب):
 *   Step 1: Click "حاضر" → instant DB draft, green banner, unlock send btn.
 *   Step 2: Click "إرسال للاعتماد" → reads grades/notes, upgrades draft→pending.
 *
 * Change #4 — Drill-Down Approval Filters:
 *   Four cascading selects: Branch → Year → Day → Time.
 *   Populated from pending records only; "Approve All" only approves filtered set.
 *   Search bar filters the rendered cards by student name or ID.
 *
 * Change #5 — No Absent Frontend State:
 *   All absent logic removed. Only 'present' records are created/sent.
 *
 * Task 2 & 3 — Reports Tab:
 *   renderReportsView() groups today's approved/synced records by
 *   Branch|Year|Day|Time, calculates total/attended/absent per group,
 *   and renders interactive report cards with mini search + expand modal.
 * -------------------------------------------------------------
 */

(() => {
  'use strict';

  /* ===================================================================
     CONFIG
     =================================================================== */

  const CONFIG = {
    // ── Supabase ──
    // هتحط هنا الـ URL والـ anon key بتوع مشروعك على Supabase.
    // سيبهم فاضيين دلوقتي زي ما طلبت — التطبيق هيشتغل أوفلاين بس لحد
    // ما تحطهم (isApiConfigured() بترجع false لو فاضيين).
    SUPABASE_URL: 'https://axmjxqcylrjwcjoigkxh.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4bWp4cWN5bHJqd2Nqb2lna3hoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMjQ3NDQsImV4cCI6MjEwMzcwMDc0NH0.q3RGF2yZHkJj2PanYpaQ9pC2pxOHdwOi8jIQlT032Rs',

    // Change #1: hardcoded admin PIN
    ADMIN_PIN: '1234',
    PIN_LENGTH: 4,

    // Change #2 (legacy fallback): ID range bases per school stage,
    // used only when a branch+year combo has no custom range defined below.
    ID_BASE_PRIMARY:     1000,  // ابتدائي
    ID_BASE_PREPARATORY: 2000,  // إعدادي
    ID_BASE_SECONDARY:   3000,  // ثانوي

    SYNC_RETRY_INTERVAL_MS: 30000,
    TOAST_DURATION_MS:      3200,

    DEFAULT_HOMEWORK_MAX: 10,
    DEFAULT_EXAM_MAX:     10,

    THEME_STORAGE_KEY:   'sayyad_theme',
    SESSION_STORAGE_KEY: 'sayyad_session_active',
  };

  // Fallback option lists if settings store is empty (first offline install).
  const FALLBACK_SETTINGS = {
    branches: ['الفرع الرئيسي', 'سنتر السرايا'],
    years: [
      'الصف الأول الابتدائي',  'الصف الثاني الابتدائي',  'الصف الثالث الابتدائي',
      'الصف الرابع الابتدائي', 'الصف الخامس الابتدائي', 'الصف السادس الابتدائي',
      'الصف الأول الإعدادي',   'الصف الثاني الإعدادي',  'الصف الثالث الإعدادي',
      'الصف الأول الثانوي',    'الصف الثاني الثانوي',   'الصف الثالث الثانوي',
    ],
    days:  ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'],
    times: ['04:00 م', '06:00 م', '08:00 م'],
  };

  /* ===================================================================
     SUPABASE CLIENT
     -------------------------------------------------------------------
     الـ SDK بيحمّل نفسه على window.supabase (من الـ CDN في index.html).
     عشان منتعارضش على الاسم، بنعمل عميل باسم مختلف (supabaseClient)
     ونسيب window.supabase زي ما هي (بتاعة المكتبة نفسها).
     لو الـ URL/KEY فاضيين، supabaseClient بتفضل null وكل الدوال اللي
     بتكلم Supabase بترجع بهدوء من غير ما تكسر شغل الأوفلاين.
     =================================================================== */

  let supabaseClient  = null;
  let realtimeChannel = null; // Supabase Realtime channel — records/students live sync

  function initSupabaseClient() {
    if (supabaseClient) return supabaseClient;
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) return null;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.warn('[Supabase] SDK غير محمّل — تأكد من تضمين الـ CDN في index.html');
      return null;
    }
    try {
      supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
      return supabaseClient;
    } catch (err) {
      console.warn('[Supabase] فشل إنشاء العميل', err);
      return null;
    }
  }

  function isApiConfigured() {
    return !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY && initSupabaseClient());
  }

  /* ── Mapping helpers: local camelCase shape <-> Supabase snake_case row ── */

  function studentToRow(student) {
    return {
      student_id:     Number(student.id),
      student_name:   student.name,
      parent_phone:   student.phone || null,
      academic_year:  student.year   || null,
      branch:         student.branch || null,
      study_day:      student.day    || null,
      study_time:     student.time   || null,
      student_group:  student.group  || null,
    };
  }

  function rowToStudent(row) {
    return {
      id:         String(row.student_id),
      name:       row.student_name,
      phone:      row.parent_phone || '',
      year:       row.academic_year || '',
      branch:     row.branch || '',
      day:        row.study_day || '',
      time:       row.study_time || '',
      group:      row.student_group || buildGroupLabel(row.academic_year, row.branch),
      syncStatus: 'synced',
      createdAt:  row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    };
  }

  /**
   * *** BUGFIX (Tombstone / Time-based merge) ***
   * لازم نبعت توقيت التحديث المحلي الحقيقي (updatedAt) مع كل سجل لجدول
   * records على Supabase، تحت عمود client_updated_at. من غيره، أي سجل
   * راجع من السيرفر كان بياخد Date.now() (وقت لحظة القراءة، مش وقت
   * التحديث الفعلي) — وده كان بيخلي أي سجل قادم من السيرفر يبان "الأحدث"
   * دايمًا بشكل خاطئ، فمنطق مقارنة الوقت في db._isNewerRecord (المستخدم
   * لحل تعارض removed ضد حضور فعلي) كان هيفشل تمامًا.
   *
   * ⚠️ يتطلب عمود جديد على جدول records في Supabase:
   *     client_updated_at  (نوع: timestamptz أو bigint، Nullable)
   *   لو العمود مش موجود، الرفع (upsert) هيفشل أو الحقل هيتجاهل حسب
   *   إعدادات RLS/schema عندك — لازم تضيفه قبل نشر هذا التحديث.
   */
  function recordToRow(record) {
    return {
      record_id:          record.recordId,
      student_id:         Number(record.studentId),
      student_name:       record.studentName || null,
      student_group:      record.group || null,
      attendance_status:  'present',
      homework_grade:     record.homeworkGrade == null ? null : Number(record.homeworkGrade),
      homework_max:       record.homeworkMax   == null ? null : Number(record.homeworkMax),
      exam_grade:         record.examGrade     == null ? null : Number(record.examGrade),
      exam_max:           record.examMax       == null ? null : Number(record.examMax),
      notes:              record.notes || null,
      status:             record.status,
      date_key:           record.dateKey,
      parent_phone:       record.parentPhone || null,
      approved_at:        record.approvedAt ? new Date(record.approvedAt).toISOString() : null,
      client_updated_at:  new Date(record.updatedAt || record.createdAt || Date.now()).toISOString(),
    };
  }

  function rowToRecord(row) {
    // *** BUGFIX: نفضّل client_updated_at (توقيت التعديل الحقيقي المُرسَل
    // من الجهاز) لو موجود؛ لو العمود مش موجود بعد (قبل ما تضيفه على
    // Supabase)، نرجع لـ approved_at ثم created_at كـ fallback آمن —
    // أفضل من Date.now() اللي كان بيكسر مقارنة الوقت تمامًا. ***
    const fallbackTime = row.approved_at || row.created_at;
    const resolvedUpdatedAt = row.client_updated_at
      ? new Date(row.client_updated_at).getTime()
      : (fallbackTime ? new Date(fallbackTime).getTime() : Date.now());

    return {
      recordId:      row.record_id,
      studentId:     String(row.student_id),
      studentName:   row.student_name || '',
      group:         row.student_group || '',
      branch:        '', // مش مخزّنة في جدول records في Supabase — هتتجاب من الطالب لو محتاجينها
      year:          '',
      day:           '',
      time:          '',
      checkinAt:     row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      homeworkGrade: row.homework_grade,
      homeworkMax:   row.homework_max,
      examGrade:     row.exam_grade,
      examMax:       row.exam_max,
      notes:         row.notes || '',
      status:        row.status || 'approved',
      dateKey:       row.date_key,
      createdAt:     row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      updatedAt:     resolvedUpdatedAt,
      approvedAt:    row.approved_at ? new Date(row.approved_at).getTime() : null,
      syncedAt:      Date.now(),
    };
  }

  /**
   * سجلات Supabase محتاجة student_group/branch/year/day/time عشان
   * الواجهة (بطاقات الطلاب، التقارير...) تشتغل صح بعد السحب.
   * الدالة دي بتكمل الحقول الناقصة من بيانات الطالب المحلية (state.students)
   * بعد ما نكون سحبناها بالفعل من fetchInitialData.
   */
  function enrichRecordFromStudent(record) {
    const student = state.students.find((s) => String(s.id) === String(record.studentId));
    if (!student) return record;
    return {
      ...record,
      studentName: record.studentName || student.name,
      group:       record.group  || student.group  || '',
      branch:      record.branch || student.branch || '',
      year:        record.year   || student.year   || '',
      day:         record.day    || student.day    || '',
      time:        record.time   || student.time   || '',
    };
  }

  /* ===================================================================
     STATE
     =================================================================== */

  const state = {
    isLoggedIn:          false,
    students:            [],
    records:             [],
    settings:            {},
    searchQuery:         '',
    activeGroup:         'all',
    // فلتر صفحة الطلاب: السنتر + المرحلة الدراسية (مستقل عن فلاتر الاعتماد)
    studentsFilterBranch: '',
    studentsFilterYear:   '',
    activeTab:           'attendance',   // 'attendance' | 'approvals' | 'reports'
    isSyncing:           false,
    isFetchingInitialData: false,
    editingRecordId:     null,
    pendingConfirmAction: null,

    // Approvals search query (Session Cards)
    approvalsSearchQuery: '',

    // Session Cards: cache of last-rendered groups + active edit-session state
    sessionGroups:     null,
    editingSessionKey: null,
    editSessionState:  null,
    editSessionGroup:  null,

    // Reports: the group key currently open in the expand modal
    reportExpandGroupKey: null,
  };

  /* ===================================================================
     DOM HELPERS
     =================================================================== */

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const els = {};

  /* ===================================================================
     UTILITIES
     =================================================================== */

  function todayKey() {
    // إجبار النظام على قراءة التوقيت بناءً على ساعة القاهرة
    const d = new Date(new Date().toLocaleString("en-US", {timeZone: "Africa/Cairo"}));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function nowTimeLabel() {
    return new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }

  function uid(prefix = 'rec') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function initials(name) {
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    return parts[0] ? parts[0][0] : '؟';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 250);
    }, CONFIG.TOAST_DURATION_MS);
  }

  function vibrate(pattern) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (_) { /* noop */ }
    }
  }

  function formatPhoneDisplay(phone) {
    if (!phone) return '';
    const digits = String(phone).replace(/\D/g, '');
    if (digits.length === 11) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return digits;
  }

  function buildGroupLabel(year, branch) {
    if (!year && !branch) return '';
    if (year && branch) return `${year} - ${branch}`;
    return year || branch;
  }

  /* ===================================================================
     INIT
     =================================================================== */

  document.addEventListener('DOMContentLoaded', async () => {
    cacheDom();
    bindStaticEvents();
    registerServiceWorker();
    applySavedTheme();

    await db.init();

    state.students = await db.getAllStudents();
    state.records  = await db.getAllRecords();
    state.settings = await db.getAllSettings();

    setupConnectivityWatchers();
    hideSplash();

    // First-run: populate fallback settings if store is empty.
    if (!state.settings || Object.keys(state.settings).length === 0) {
      for (const key of Object.keys(FALLBACK_SETTINGS)) {
        await db.setSetting(key, FALLBACK_SETTINGS[key]);
      }
      state.settings = await db.getAllSettings();
    }

    // Fetch fresh data from server if online.
    if (navigator.onLine) {
      fetchInitialData();
      setupRealtimeSync();
    }

    // Change #1: restore session via a simple flag in localStorage
    const sessionActive = localStorage.getItem(CONFIG.SESSION_STORAGE_KEY);
    if (sessionActive === 'true') {
      state.isLoggedIn = true;
      enterApp();
    } else {
      showLogin();
    }
  });

  function cacheDom() {
    els.splashScreen   = $('#splashScreen');
    els.loginModal     = $('#loginModal');
    els.pinDisplay     = $('#pinDisplay');
    els.pinDots        = $$('.pin-dot', document);
    els.pinError       = $('#pinError');
    els.pinPad         = $('#pinPad');

    els.app            = $('#app');
    els.syncBadge      = $('#syncBadge');
    els.syncBadgeText  = $('#syncBadgeText');
    els.themeToggleBtn = $('#themeToggleBtn');
    els.logoutBtn      = $('#logoutBtn');
    els.addStudentBtn  = $('#addStudentBtn');

    els.tabAttendance  = $('#tabAttendance');
    els.tabApprovals   = $('#tabApprovals');
    els.tabReports     = $('#tabReports');          // Task 3 — new tab
    els.pendingTabBadge = $('#pendingTabBadge');

    els.attendanceView = $('#attendanceView');
    els.approvalsView  = $('#approvalsView');
    els.reportsView    = $('#reportsView');          // Task 3 — new view

    els.studentSearch    = $('#studentSearch');
    els.clearSearchBtn   = $('#clearSearchBtn');
    els.qrScanBtn        = $('#qrScanBtn');
    els.qrScanModal      = $('#qrScanModal');
    els.qrScanModalClose = $('#qrScanModalClose');
    els.qrReader         = $('#qrReader');
    els.qrScanHint       = $('#qrScanHint');
    els.groupChips       = $('#groupChips');
    els.studentsList     = $('#studentsList');
    els.noResults        = $('#noResults');
    els.pendingCountDisplay = $('#pendingCountDisplay');
    els.localQueueSummary   = $('#localQueueSummary');

    // فلتر صفحة الطلاب: السنتر + المرحلة الدراسية
    els.studentsFilterBranch = $('#studentsFilterBranch');
    els.studentsFilterYear   = $('#studentsFilterYear');

    els.statTotalStudents   = $('#statTotalStudents');
    els.statActiveGroups    = $('#statActiveGroups');
    els.statPendingApprovals = $('#statPendingApprovals');
    els.statApprovedToday   = $('#statApprovedToday');
    els.approvalsList       = $('#approvalsList');
    els.noApprovals         = $('#noApprovals');
    els.approveAllBtn       = $('#approveAllBtn');

    // Task 2 — Approvals search
    els.approvalsSearch      = $('#approvalsSearch');
    els.clearApprovalsSearch = $('#clearApprovalsSearchBtn');

    els.studentCardTemplate  = $('#studentCardTemplate');
    els.sessionCardTemplate  = $('#sessionCardTemplate');
    els.reportCardTemplate   = $('#reportCardTemplate');  // Task 3

    // Reports view elements
    els.reportCardsList   = $('#reportCardsList');
    els.noReports         = $('#noReports');
    els.reportsTodayLabel = $('#reportsTodayLabel');

    // Reports expand modal
    els.reportExpandModal   = $('#reportExpandModal');
    els.reportExpandClose   = $('#reportExpandClose');
    els.reportExpandTitle   = $('#reportExpandTitle');
    els.reportExpandSub     = $('#reportExpandSub');
    els.reportExpandSearch  = $('#reportExpandSearch');
    els.reportExpandMetrics = $('#reportExpandMetrics');
    els.reportExpandList    = $('#reportExpandList');

    // Edit Session modal
    els.editSessionModal        = $('#editSessionModal');
    els.editSessionModalClose   = $('#editSessionModalClose');
    els.editSessionTitle        = $('#editSessionTitle');
    els.editSessionSub          = $('#editSessionSub');
    els.editSessionSearch       = $('#editSessionSearch');
    els.editSessionStudentList  = $('#editSessionStudentList');
    els.editSessionRowTemplate  = $('#editSessionStudentRowTemplate');
    els.cancelEditSessionBtn    = $('#cancelEditSessionBtn');
    els.saveSessionEditBtn      = $('#saveSessionEditBtn');

    // Confirm modal
    els.confirmModal     = $('#confirmModal');
    els.confirmTitle     = $('#confirmTitle');
    els.confirmMessage   = $('#confirmMessage');
    els.confirmCancelBtn = $('#confirmCancelBtn');
    els.confirmOkBtn     = $('#confirmOkBtn');

    // Add student modal
    els.addStudentModal     = $('#addStudentModal');
    els.addStudentModalClose = $('#addStudentModalClose');
    els.newStudentName      = $('#newStudentName');
    els.newStudentPhone     = $('#newStudentPhone');
    els.newStudentYear      = $('#newStudentYear');
    els.newStudentBranch    = $('#newStudentBranch');
    els.newStudentDay       = $('#newStudentDay');
    els.newStudentTime      = $('#newStudentTime');
    els.cancelAddStudentBtn = $('#cancelAddStudentBtn');
    els.saveNewStudentBtn   = $('#saveNewStudentBtn');
    els.idPreviewValue      = $('#idPreviewValue');

    els.toastContainer = $('#toastContainer');
  }

  function hideSplash() {
    setTimeout(() => {
      els.splashScreen.classList.add('fade-out');
    }, 450);
  }

  /* ===================================================================
     THEME TOGGLE
     =================================================================== */

  function applySavedTheme() {
    let saved = null;
    try { saved = localStorage.getItem(CONFIG.THEME_STORAGE_KEY); } catch (_) { /* noop */ }
    const isLight = saved ? saved === 'light' : true;
    document.body.classList.toggle('light-theme', isLight);
  }

  function toggleTheme() {
    const isNowLight = !document.body.classList.contains('light-theme');
    document.body.classList.toggle('light-theme', isNowLight);
    try { localStorage.setItem(CONFIG.THEME_STORAGE_KEY, isNowLight ? 'light' : 'dark'); } catch (_) { /* noop */ }
    vibrate(10);
  }

  /* ===================================================================
     TAB NAVIGATION — Task 3: extended to support 3rd "reports" tab
     =================================================================== */

  function switchTab(tab) {
    state.activeTab = tab;

    // Toggle tab button active states
    els.tabAttendance.classList.toggle('active', tab === 'attendance');
    els.tabApprovals.classList.toggle('active',  tab === 'approvals');
    els.tabReports.classList.toggle('active',    tab === 'reports');

    // Toggle view visibility
    els.attendanceView.classList.toggle('hidden', tab !== 'attendance');
    els.approvalsView.classList.toggle('hidden',  tab !== 'approvals');
    els.reportsView.classList.toggle('hidden',    tab !== 'reports');

    if (tab === 'approvals') {
      renderApprovalsView();
    }

    // Task 3 — render reports on tab click (auto-reset logic lives inside)
    if (tab === 'reports') {
      renderReportsView();
    }
  }

  /* ===================================================================
     API — INITIAL DATA FETCH
     =================================================================== */

  /**
   * PULL قبل الحصة: نجيب كل الطلاب + الإعدادات + سجلات النهاردة من Supabase
   * ونخزّنهم في IndexedDB. ده بيحصل أونلاين قبل ما المعلم يدخل الأوفلاين.
   */
  async function fetchInitialData() {
    if (state.isFetchingInitialData || !navigator.onLine) return;
    state.isFetchingInitialData = true;
    updateSyncBadge();

    try {
      const sb = initSupabaseClient();
      if (!sb) {
        console.info('[Init] Supabase غير مُهيّأ (URL/KEY فاضيين) — التطبيق شغال على البيانات المحفوظة محليًا.');
        return;
      }

      // 1) كل الطلاب
      const { data: studentRows, error: studentsErr } = await sb
        .from('students')
        .select('*');
      if (studentsErr) throw studentsErr;

      if (Array.isArray(studentRows)) {
        const mapped = studentRows.map(rowToStudent);
        state.students = await db.replaceAllStudents(mapped);
      }

      // 2) كل الإعدادات (category/value) — نجمّعها في شكل {branches:[...], years:[...], ...}
      const { data: settingsRows, error: settingsErr } = await sb
        .from('settings')
        .select('*');
      if (settingsErr) throw settingsErr;

      if (Array.isArray(settingsRows) && settingsRows.length > 0) {
        const grouped = {};
        settingsRows.forEach((row) => {
          const cat = row.category;
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(row.value);
        });
        for (const key of Object.keys(grouped)) {
          await db.setSetting(key, grouped[key]);
        }
        state.settings = await db.getAllSettings();
      }

      // 3) سجلات النهاردة بس (date_key = اليوم) — عشان الجهاز يبقى عارف
      //    مين خلّص حضوره/اعتماده بالفعل من أجهزة تانية قبل ما ندخل الأوفلاين.
      const today = todayKey();
      const { data: recordRows, error: recordsErr } = await sb
        .from('records')
        .select('*')
        .eq('date_key', today);
      if (recordsErr) throw recordsErr;

      if (Array.isArray(recordRows)) {
        for (const row of recordRows) {
          const localRecord = enrichRecordFromStudent(rowToRecord(row));
          // dedup بالـ student_id + date_key — لا تكرار لنفس الطالب في نفس اليوم
          await db.mergeServerRecord(localRecord);
        }
        state.records = await db.getAllRecords();
      }

      await db.setMeta('lastFetchAt', Date.now());
      console.info('[Init] تم تحديث البيانات من Supabase.');
    } catch (err) {
      console.warn('[Init] تعذّر جلب البيانات من Supabase.', err);
    } finally {
      state.isFetchingInitialData = false;
      updateSyncBadge();
      if (state.isLoggedIn) {
        buildGroupChips();
        renderStudentsList();
        updatePendingBadge();
      }
    }
  }

  /* ===================================================================
     CHANGE #1 — STATIC PIN AUTHENTICATION
     =================================================================== */

  let pinBuffer = '';

  function showLogin() {
    pinBuffer = '';
    renderPinDots();
    els.pinError.classList.add('hidden');
    els.loginModal.classList.remove('hidden');
    els.loginModal.setAttribute('aria-hidden', 'false');
    els.app.classList.add('hidden');
  }

  function renderPinDots() {
    els.pinDots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < pinBuffer.length);
      dot.classList.remove('shake-error');
    });
  }

  function bindStaticEvents() {
    // PIN pad
    els.pinPad.addEventListener('click', (e) => {
      const keyBtn = e.target.closest('.pin-key');
      if (!keyBtn) return;

      if (keyBtn.id === 'pinClear') {
        pinBuffer = '';
        els.pinError.classList.add('hidden');
        renderPinDots();
        return;
      }
      if (keyBtn.id === 'pinBackspace') {
        pinBuffer = pinBuffer.slice(0, -1);
        renderPinDots();
        return;
      }

      const digit = keyBtn.dataset.key;
      if (digit == null || pinBuffer.length >= CONFIG.PIN_LENGTH) return;
      pinBuffer += digit;
      renderPinDots();
      if (pinBuffer.length === CONFIG.PIN_LENGTH) {
        setTimeout(() => attemptLogin(pinBuffer), 120);
      }
    });

    // Physical keyboard PIN support
    document.addEventListener('keydown', (e) => {
      if (els.loginModal.classList.contains('hidden')) return;
      if (/^[0-9]$/.test(e.key) && pinBuffer.length < CONFIG.PIN_LENGTH) {
        pinBuffer += e.key;
        renderPinDots();
        if (pinBuffer.length === CONFIG.PIN_LENGTH) {
          setTimeout(() => attemptLogin(pinBuffer), 120);
        }
      } else if (e.key === 'Backspace') {
        pinBuffer = pinBuffer.slice(0, -1);
        renderPinDots();
      }
    });

    els.logoutBtn.addEventListener('click', handleLogout);
    els.themeToggleBtn.addEventListener('click', toggleTheme);
    els.addStudentBtn.addEventListener('click', openAddStudentModal);

    // Tab switching — Task 3: third tab wired up
    els.tabAttendance.addEventListener('click', () => switchTab('attendance'));
    els.tabApprovals.addEventListener('click',  () => switchTab('approvals'));
    els.tabReports.addEventListener('click',    () => switchTab('reports'));

    // Attendance search
    els.studentSearch.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim();
      els.clearSearchBtn.classList.toggle('hidden', state.searchQuery.length === 0);
      renderStudentsList();
    });
    els.clearSearchBtn.addEventListener('click', () => {
      els.studentSearch.value = '';
      state.searchQuery = '';
      els.clearSearchBtn.classList.add('hidden');
      renderStudentsList();
      els.studentSearch.focus();
    });

    // بحث عن طريق مسح QR Code
    els.qrScanBtn.addEventListener('click', openQrScanModal);
    els.qrScanModalClose.addEventListener('click', closeQrScanModal);
    els.qrScanModal.addEventListener('click', (e) => {
      if (e.target === els.qrScanModal) closeQrScanModal();
    });

    // ── Task 2 — Approvals in-view search (now filters Session Cards) ──
    els.approvalsSearch.addEventListener('input', (e) => {
      state.approvalsSearchQuery = e.target.value.trim().toLowerCase();
      els.clearApprovalsSearch.classList.toggle('hidden', state.approvalsSearchQuery.length === 0);
      renderSessionCards();
    });
    els.clearApprovalsSearch.addEventListener('click', () => {
      els.approvalsSearch.value  = '';
      state.approvalsSearchQuery = '';
      els.clearApprovalsSearch.classList.add('hidden');
      renderSessionCards();
      els.approvalsSearch.focus();
    });

    // Group chips (delegated)
    els.groupChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.activeGroup = chip.dataset.group;
      $$('.chip', els.groupChips).forEach((c) => c.classList.toggle('active', c === chip));
      renderStudentsList();
    });

    // فلتر صفحة الطلاب: السنتر + المرحلة الدراسية
    if (els.studentsFilterBranch) {
      els.studentsFilterBranch.addEventListener('change', () => {
        state.studentsFilterBranch = els.studentsFilterBranch.value;
        renderStudentsList();
      });
    }
    if (els.studentsFilterYear) {
      els.studentsFilterYear.addEventListener('change', () => {
        state.studentsFilterYear = els.studentsFilterYear.value;
        renderStudentsList();
      });
    }

    // Students list (delegated)
    els.studentsList.addEventListener('click', handleStudentListClick);

    // Approvals list (delegated) — Session Cards architecture
    els.approvalsList.addEventListener('click', handleApprovalsListClick);

    // Edit Session modal
    els.editSessionModalClose.addEventListener('click', closeEditSessionModal);
    els.editSessionModal.addEventListener('click', (e) => { if (e.target === els.editSessionModal) closeEditSessionModal(); });
    els.cancelEditSessionBtn.addEventListener('click', closeEditSessionModal);
    els.saveSessionEditBtn.addEventListener('click', saveSessionEdit);
    els.editSessionSearch.addEventListener('input', () => {
      renderEditSessionStudentList(els.editSessionSearch.value.trim().toLowerCase());
    });

    // Confirm modal
    els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
    els.confirmModal.addEventListener('click', (e) => { if (e.target === els.confirmModal) closeConfirmModal(); });
    els.confirmOkBtn.addEventListener('click', () => {
      if (typeof state.pendingConfirmAction === 'function') state.pendingConfirmAction();
      closeConfirmModal();
    });

    // Add student modal
    els.addStudentModalClose.addEventListener('click', closeAddStudentModal);
    els.cancelAddStudentBtn.addEventListener('click', closeAddStudentModal);
    els.addStudentModal.addEventListener('click', (e) => { if (e.target === els.addStudentModal) closeAddStudentModal(); });
    els.saveNewStudentBtn.addEventListener('click', saveNewStudent);

    // Change #2: update ID preview live when year or branch changes
    els.newStudentYear.addEventListener('change', updateIdPreview);
    els.newStudentBranch.addEventListener('change', updateIdPreview);

    // ── Task 3 — Reports expand modal ──
    els.reportExpandClose.addEventListener('click', closeReportExpandModal);
    els.reportExpandModal.addEventListener('click', (e) => {
      if (e.target === els.reportExpandModal) closeReportExpandModal();
    });
    els.reportExpandSearch.addEventListener('input', () => {
      renderExpandModalList(state.reportExpandGroupKey, els.reportExpandSearch.value.trim().toLowerCase());
    });
  }

  /**
   * Change #1: compares against hardcoded ADMIN_PIN only.
   */
  function attemptLogin(pin) {
    if (pin !== CONFIG.ADMIN_PIN) {
      els.pinError.classList.remove('hidden');
      els.pinDots.forEach((d) => d.classList.add('shake-error'));
      els.pinDisplay.classList.add('shake');
      vibrate([60, 40, 60]);
      setTimeout(() => {
        els.pinDisplay.classList.remove('shake');
        pinBuffer = '';
        renderPinDots();
      }, 420);
      return;
    }

    state.isLoggedIn = true;
    try { localStorage.setItem(CONFIG.SESSION_STORAGE_KEY, 'true'); } catch (_) { /* noop */ }
    els.pinError.classList.add('hidden');
    enterApp();
  }

  function handleLogout() {
    openConfirm(
      'تسجيل الخروج',
      'هل تريد بالفعل تسجيل الخروج من النظام؟',
      () => {
        state.isLoggedIn = false;
        try { localStorage.removeItem(CONFIG.SESSION_STORAGE_KEY); } catch (_) { /* noop */ }
        els.app.classList.add('hidden');
        showLogin();
      }
    );
  }

  function enterApp() {
    els.loginModal.classList.add('hidden');
    els.loginModal.setAttribute('aria-hidden', 'true');
    els.app.classList.remove('hidden');

    switchTab('attendance');
    buildGroupChips();
    renderStudentsList();
    updatePendingBadge();
    updateSyncBadge();

    if (navigator.onLine) {
      fetchInitialData();
    }
  }

  /* ===================================================================
     CONNECTIVITY / SYNC ENGINE
     =================================================================== */

  function setupConnectivityWatchers() {
    window.addEventListener('online', () => {
      updateSyncBadge();
      showToast('تم استعادة الاتصال بالإنترنت، جاري المزامنة...', 'info');
      triggerSync();
      setupRealtimeSync(); // لو كانت القناة اتقفلت أثناء الانقطاع، حاول تاني
    });
    window.addEventListener('offline', () => {
      updateSyncBadge();
      showToast('انقطع الاتصال بالإنترنت — سيتم الحفظ محليًا', 'error');
    });

    setInterval(() => {
      if (navigator.onLine && !state.isSyncing) triggerSync();
    }, CONFIG.SYNC_RETRY_INTERVAL_MS);
  }

  function updateSyncBadge() {
    els.syncBadge.classList.remove('online', 'offline', 'syncing');
    if (state.isSyncing || state.isFetchingInitialData) {
      els.syncBadge.classList.add('syncing');
      els.syncBadgeText.textContent = 'جاري المزامنة';
    } else if (navigator.onLine) {
      els.syncBadge.classList.add('online');
      els.syncBadgeText.textContent = 'متصل';
    } else {
      els.syncBadge.classList.add('offline');
      els.syncBadgeText.textContent = 'غير متصل';
    }
  }

  /**
   * SYNC (بعد رجوع النت وقت/بعد الحصة):
   *   1. PUSH الطلاب الجدد (pending_creation) لجدول students.
   *   2. PUSH السجلات اللي محتاجة ترفع لجدول records:
   *        - "pending"  → لسه بانتظار اعتماد الأدمن (رفعها هنا هو اللي
   *                        بيخلّي طابور الاعتماد المركزي يشوفها أصلاً).
   *        - "approved" → اتعمدت محليًا وجاهزة تتقفل كـ "synced".
   *        - "failed"   → محاولة رفع سابقة فشلت، بنعيد المحاولة.
   *      *** BUGFIX: قبل كده كانت approved/failed بس، فالـ pending records
   *      (اللي هي أصل طابور الاعتماد) ما كانتش بتتبعت خالص. ***
   *   3. PULL فوري لكل سجلات النهاردة من Supabase، ودمجها محليًا بمنع التكرار
   *      (student_id + date_key) — عشان أي جهاز تاني يبقى شايف نفس الصورة.
   */
  async function triggerSync() {
    if (state.isSyncing || !navigator.onLine) return;

    const sb = initSupabaseClient();
    if (!sb) return; // Supabase مش متهيّأ — نفضل نشتغل أوفلاين بهدوء

    // *** BUGFIX (Sync Overwrite): PULL الأول قبل أي PUSH — عشان لو جهاز
    // تاني (Device A) اعتمد سجل على السيرفر، الجهاز ده يحدّث نسخته المحلية
    // لأعلى حالة (approved) الأول، قبل ما يحاول يبعت نسخته القديمة (pending)
    // ويكتب فوق حالة السيرفر غلط. ***
    await pullTodayRecordsAndMerge(sb);
    state.students = await db.getAllStudents();
    state.records  = await db.getAllRecords();

    const pendingStudents = await db.getStudentsPendingCreation();
    // *** BUGFIX: لازم نضيف 'pending' هنا — دي السجلات اللي المستخدم
    // لسه دلوقتي ضغط "إرسال للاعتماد" عليها. من غيرها الأدمن مش هيشوف
    // حاجة في طابور الاعتماد المركزي أبدًا. ***
    //
    // *** BUGFIX (سجلات يتيمة بعد استبدال قاعدة البيانات) ***
    // لو الأدمن مسح/استبدل جدول الطلاب على Supabase، أي سجل محلي
    // pending/failed/draft كان قاعد على جهاز لطالب "مبقاش موجود" في
    // state.students الحالية، كان بيترفع تاني لـ Supabase كل مرة يحصل
    // sync. الحل: أي سجل كده يتحذف محليًا فورًا قبل أي محاولة رفع.
    const knownStudentIds = new Set(state.students.map((s) => String(s.id)));
    const orphanedRecords = state.records.filter(
      (r) => (r.status === 'pending' || r.status === 'failed' ||
              r.status === 'draft'   || r.status === 'removed') &&
             !knownStudentIds.has(String(r.studentId))
    );
    for (const orphan of orphanedRecords) {
      await db.deleteRecord(orphan.recordId);
    }
    if (orphanedRecords.length > 0) {
      state.records = await db.getAllRecords();
    }

    // *** BUGFIX (Tombstone): 'removed' لازم يترفع برضه، وإلا هيفضل السجل
    // القديم (الحضور) هو الظاهر على السيرفر، وأي جهاز يسحبه هيرجّعه محليًا. ***
    const toSyncRecords = state.records.filter(
      (r) => r.status === 'pending' || r.status === 'approved' ||
             r.status === 'failed'  || r.status === 'removed'
    );

    if (pendingStudents.length === 0 && toSyncRecords.length === 0) {
      // مفيش حاجة نبعتها، وأصلًا سحبنا فوق — مفيش داعي لأي حاجة تانية
      return;
    }

    state.isSyncing = true;
    updateSyncBadge();

    // ── 1) PUSH الطلاب الجدد ──
    for (const student of pendingStudents) {
      try {
        const ok = await pushStudentToApi(sb, student);
        if (ok) {
          await db.upsertStudent({ ...student, syncStatus: 'synced' });
        }
      } catch (err) { /* هنعيد المحاولة في الدورة الجاية */ }
    }

    // ── 2) PUSH السجلات ──
    //
    // *** FIX (Race Protection — PUSH) ***
    // الـ PULL اللي فوق (بداية الدالة) بيتم مرة واحدة قبل الحلقة دي، لكن
    // بينه وبين لحظة رفع كل سجل بالفعل ممكن يكون فيه ثواني بتعدي (خصوصًا
    // لو فيه سجلات كتير)، وجهاز تاني ممكن يكون اعتمد/زامن سجل لنفس
    // الطالب في اليوم في نفس اللحظة دي بالظبط. عشان نقفل الفجوة دي لأقصى
    // درجة ممكنة، بنعمل فحص "طازة" ومباشر لحالة كل سجل على السيرفر (batched
    // حسب dateKey) قبل أي رفع فعلي — مش هنعتمد بس على الـ PULL الجماعي اللي فات.
    const serverRankMap = await fetchServerRecordRanks(sb, toSyncRecords);

    let recSuccess = 0, recFail = 0, recSkipped = 0;
    for (const record of toSyncRecords) {
      // نحتفظ بالحالة الأصلية قبل المحاولة عشان نعرف الحالة "المستهدفة"
      // بعد نجاح الرفع — رفع سجل "pending" لازم يفضل "pending" محليًا
      // (لسه بانتظار اعتماد الأدمن)، مش يتحول لـ "synced" غلط.
      const wasStatus = record.status;
      const rankKey   = `${Number(record.studentId)}|${record.dateKey}`;
      const serverTop = serverRankMap.get(rankKey);

      // *** استخدام _isNewerRecord بدل مقارنة رتبة مباشرة — عشان تعارض
      // removed ضد pending/approved يتحسم بالوقت (updatedAt) لما يكون
      // فيه تنافس حقيقي، مش برتبة ثابتة قد تكون غلط في اتجاه واحد. ***
      if (serverTop && db._isNewerRecord(serverTop.row ? enrichRecordFromStudent(rowToRecord(serverTop.row)) : { status: null }, record)) {
        // *** FIX: في جهاز تاني سبقنا فعلاً بنسخة أوفق (مثلاً اعتمد/زامن
        // السجل ده) — منرفعش نسختنا القديمة فوقها (ده اللي كان بيسبب رجوع
        // سجلات معتمدة لـ pending). بدل كده، نلحق بالحالة الصحيحة محليًا
        // عن طريق نفس منطق الدمج (rank-aware) ونعتبر الرفع ده "متجاوَز"،
        // مش فشل حقيقي (فمنعملهوش retry كـ failed).
        try {
          const mergedRecord = enrichRecordFromStudent(rowToRecord(serverTop.row));
          await db.mergeServerRecord(mergedRecord);
        } catch (err) {
          console.warn('[Sync] تعذّر دمج نسخة السيرفر الأوفق أثناء تجاوز الرفع', err);
        }
        recSkipped++;
        continue;
      }

      try {
        const ok = await pushRecordToApi(sb, record);
        if (ok) {
          // *** BUGFIX: الحالة بعد النجاح تعتمد على وين كان السجل ذاهب،
          // مش تتثبّت على 'synced' دايمًا:
          //   - approved (أو failed كان أصله approved) → synced (اكتمل تمامًا).
          //   - pending  (أو failed كان أصله pending)  → يفضل pending
          //     محليًا، لأنه لسه محتاج اعتماد الأدمن؛ الرفع هنا معناه بس
          //     إنه بقى مرئي في طابور الاعتماد المركزي على Supabase.
          //   - removed  (tombstone غياب) → يفضل removed زي ما هو، مش
          //     تتحول لحالة تانية غلط.
          if (wasStatus === 'approved') record.status = 'synced';
          else if (wasStatus === 'removed') record.status = 'removed';
          else record.status = 'pending';
          record.syncedAt = Date.now();
          await db.upsertRecord(record);
          recSuccess++;
        } else {
          record.status = 'failed';
          record.failedFromStatus = wasStatus === 'failed' ? (record.failedFromStatus || wasStatus) : wasStatus;
          await db.upsertRecord(record);
          recFail++;
        }
      } catch (err) {
        record.status = 'failed';
        record.failedFromStatus = wasStatus === 'failed' ? (record.failedFromStatus || wasStatus) : wasStatus;
        await db.upsertRecord(record);
        recFail++;
      }
    }

    // ── 3) PULL فوري بعد الدفع، لضمان مطابقة كل الأجهزة لنفس الصورة ──
    await pullTodayRecordsAndMerge(sb);

    state.students = await db.getAllStudents();
    state.records  = await db.getAllRecords();
    state.isSyncing = false;
    updateSyncBadge();

    if (recSuccess > 0) showToast(`تمت مزامنة ${recSuccess} سجل بنجاح`, 'success');
    if (recFail    > 0) showToast(`تعذّرت مزامنة ${recFail} سجل، سيُعاد المحاولة تلقائيًا`, 'error');
    if (recSkipped > 0) showToast(`تم تجاهل رفع ${recSkipped} سجل لأن جهاز آخر اعتمده/زامنه بالفعل`, 'info');

    refreshCurrentTabView();
  }

  /**
   * *** FIX (Race Protection — PUSH) ***
   * فحص "طازة" ومباشر (مش من الـ PULL الجماعي اللي حصل في بداية triggerSync)
   * لأعلى حالة موجودة فعليًا على السيرفر لكل سجل هنرفعه، مجمّع (batched)
   * حسب dateKey لتقليل عدد الطلبات. بيرجع Map:
   *   `${studentId}|${dateKey}` → { rank, row }
   * لو السيرفر مالوش سجل لنفس الطالب/اليوم أصلاً، مش هيتضاف مفتاح ليه في
   * الـ Map (يعني آمن نرفع السجل عادي — مفيش حد سبقنا بيه).
   */
  async function fetchServerRecordRanks(sb, records) {
    const map = new Map();
    if (!Array.isArray(records) || records.length === 0) return map;

    const studentIdsByDateKey = {};
    records.forEach((r) => {
      const dk = r.dateKey || todayKey();
      if (!studentIdsByDateKey[dk]) studentIdsByDateKey[dk] = new Set();
      studentIdsByDateKey[dk].add(Number(r.studentId));
    });

    for (const dateKey in studentIdsByDateKey) {
      const studentIds = Array.from(studentIdsByDateKey[dateKey]);
      if (studentIds.length === 0) continue;
      try {
        const { data, error } = await sb
          .from('records')
          .select('*')
          .eq('date_key', dateKey)
          .in('student_id', studentIds);
        if (error) throw error;

        (data || []).forEach((row) => {
          const key  = `${row.student_id}|${row.date_key}`;
          const rank = db._recordRank(row.status);
          const existing = map.get(key);
          if (!existing || rank > existing.rank) {
            map.set(key, { rank, row });
          }
        });
      } catch (err) {
        // فشل صامت — لو الفحص الطازة فشل، بنرجع لسلوك الرفع العادي
        // (مش هنعتبره حظر)، لأن الـ PULL الجماعي في بداية الدورة أصلاً
        // بيدي حماية معقولة، والفحص ده تحسين إضافي مش الحماية الوحيدة.
        console.warn('[Sync] تعذّر التحقق الطازة من حالة السجلات قبل الرفع', err);
      }
    }

    return map;
  }

  /**
   * تجميعة التحديثات المشتركة بعد أي مصدر بيانات جديد (sync / realtime) —
   * مستخدمة في أكتر من مكان عشان الواجهة تفضل متطابقة مع الحالة المحلية.
   */
  function refreshCurrentTabView() {
    updatePendingBadge();
    if (state.activeTab === 'attendance') renderStudentsList();
    if (state.activeTab === 'approvals')  renderApprovalsView();
    if (state.activeTab === 'reports')    renderReportsView();
  }

  /**
   * يسحب سجلات النهاردة من Supabase ويدمجها محليًا مع منع التكرار.
   * قاعدة مهمة: سجل محلي "draft" (خطوة 1 لسه ما بعتتش) ما بيتلمسش هنا إلا
   * لو فعلاً فيه سجل مختلف من جهاز تاني لنفس الطالب/اليوم وصل السيرفر —
   * وقتها بيانات السيرفر (الأوفق/الأحدث اعتمادًا) بتاخد الأولوية
   * (المنطق ده جوه db.mergeServerRecord).
   */
  async function pullTodayRecordsAndMerge(sb) {
    try {
      const today = todayKey();
      const { data: recordRows, error } = await sb
        .from('records')
        .select('*')
        .eq('date_key', today);
      if (error) throw error;

      if (Array.isArray(recordRows)) {
        for (const row of recordRows) {
          const localRecord = enrichRecordFromStudent(rowToRecord(row));
          await db.mergeServerRecord(localRecord);
        }
        state.records = await db.getAllRecords();

        // Session Cards / Reports / Attendance auto-refresh, عشان أي جهاز
        // يشوف حالة السجلات الحقيقية فورًا (زرار "حاضر" يتعطل تلقائيًا
        // لو الجلسة اتعمدت من جهاز تاني، بدل ما يفضل شغال بالغلط).
        refreshCurrentTabView();
      }
    } catch (err) {
      console.warn('[Sync] تعذّر سحب سجلات اليوم من Supabase.', err);
    }
  }

  /**
   * PUSH سجل واحد لجدول records في Supabase.
   * بنستخدم upsert بمفتاح record_id (PRIMARY KEY) عشان لو السجل اتبعت
   * قبل كده (مثلاً فشل ثم حاولنا تاني)، يتحدّث بدل ما يتكرر.
   */
  async function pushRecordToApi(sb, record) {
    try {
      const row = recordToRow(record);
      const { error } = await sb
        .from('records')
        .upsert(row, { onConflict: 'record_id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.warn('[Sync] Record push failed', record.recordId, err);
      return false; // فشل صامت — هنعيد المحاولة تلقائيًا في الدورة الجاية
    }
  }

  /**
   * PUSH طالب جديد اتسجل أوفلاين لجدول students في Supabase.
   * upsert بمفتاح student_id عشان لو نفس الطالب اتحاول رفعه مرتين
   * (مثلاً فشلت المحاولة الأولى) ميتكررش.
   */
  async function pushStudentToApi(sb, student) {
    try {
      const row = studentToRow(student);
      const { error } = await sb
        .from('students')
        .upsert(row, { onConflict: 'student_id' });
      if (error) throw error;
      return true;
    } catch (err) {
      console.warn('[Sync] Student push failed', student.id, err);
      return false; // فشل صامت — هيفضل pending_creation لحد النجاح
    }
  }

  /**
   * *** FIX (Realtime — بدل الاعتماد على الـ 30 ثانية بس) ***
   * بدل ما كل جهاز يستنى لحد 30 ثانية (أو دورة الـ polling الجاية) عشان
   * يعرف إن سجل اتعمد/اتغيّر/اتمسح على السيرفر، بنعمل اشتراك Realtime في
   * جدولي records وstudents. أي INSERT/UPDATE/DELETE بيوصل فورًا (خلال
   * أجزاء من الثانية) لكل الأجهزة المتصلة، وبيتدمج بنفس منطق الرتبة
   * (mergeServerRecord) اللي بيحمي من التراجع.
   *
   * *** ملحوظة تشغيلية مهمة (لازم تتعمل مرة واحدة من لوحة Supabase) ***
   * الاشتراك ده معتمد على إن جدولي "records" و"students" مفعّل عليهم
   * Realtime replication من Database → Replication في لوحة تحكم Supabase
   * (توگل بسيط لكل جدول). من غير الخطوة دي، الاشتراك هيفضل "مفتوح" بس
   * مش هيستقبل أي حدث، والتطبيق هيرجع تلقائيًا يعتمد على الـ polling كل
   * 30 ثانية كـ fallback (مفيش أي كسر لو الخطوة دي متعملتش).
   *
   * الاشتراك مش شرط للتشغيل الصحيح — هو تحسين للسرعة/الدقة فقط. لو فشل
   * لأي سبب (شبكة، إعدادات)، كل الحماية التانية (rank/merge/الفحص الطازة
   * قبل الرفع) شغالة برضه بشكل مستقل.
   */
  function setupRealtimeSync() {
    if (realtimeChannel) return; // مسجّل بالفعل
    const sb = initSupabaseClient();
    if (!sb || typeof sb.channel !== 'function') return;

    try {
      realtimeChannel = sb
        .channel('sayyad-live-sync')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'records' },
          handleRealtimeRecordChange
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'students' },
          handleRealtimeStudentChange
        )
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            // فشل صامت — نفضل نعتمد على الـ polling العادي كـ fallback،
            // ونسمح بمحاولة إعادة الاشتراك في المرة الجاية اللي setupRealtimeSync
            // بتتنادى فيها (مثلاً عند استعادة الاتصال).
            console.warn('[Realtime] القناة اتقفلت/فشلت (' + status + ') — الاعتماد على المزامنة الدورية.');
            if (realtimeChannel) {
              try { sb.removeChannel(realtimeChannel); } catch (_) { /* noop */ }
            }
            realtimeChannel = null;
          }
        });
    } catch (err) {
      console.warn('[Realtime] تعذّر إنشاء قناة التحديث الفوري — الاعتماد على المزامنة الدورية.', err);
      realtimeChannel = null;
    }
  }

  /**
   * INSERT/UPDATE: سجل جديد أو حالته اتغيّرت (مثلاً جهاز تاني اعتمد سجل) —
   * بيتدمج فورًا بنفس منطق الرتبة، فمينفعش يرجّع سجل معتمد لحالة أقل.
   * DELETE: سجل اتمسح مباشرة من الداتابيز (يدويًا من لوحة Supabase مثلاً) —
   * بيتمسح محليًا فورًا بدل ما الجهاز يحاول "يرفعه تاني" في دورة الـ sync
   * الجاية على أساس إنه لسه pending عنده.
   */
  async function handleRealtimeRecordChange(payload) {
    try {
      if (payload.eventType === 'DELETE') {
        const oldRow = payload.old || {};
        if (oldRow.record_id) {
          await db.deleteRecord(oldRow.record_id);
          state.records = await db.getAllRecords();
          refreshCurrentTabView();
        }
        return;
      }

      const row = payload.new;
      if (!row) return;
      const record = enrichRecordFromStudent(rowToRecord(row));
      await db.mergeServerRecord(record);
      state.records = await db.getAllRecords();
      refreshCurrentTabView();
    } catch (err) {
      console.warn('[Realtime] فشل معالجة تحديث سجل فوري', err);
    }
  }

  /**
   * طالب جديد اتضاف من جهاز تاني، أو بياناته اتعدّلت — بيتحدّث محليًا فورًا
   * عشان القوائم/الفلاتر/حساب الغياب يفضلوا متطابقين بين كل الأجهزة.
   * DELETE نادرة (مفيش زرار حذف طالب في الواجهة حاليًا) — بنعيد جلب كل
   * البيانات من السيرفر كحل بسيط وآمن بدل منطق دمج جزئي.
   */
  async function handleRealtimeStudentChange(payload) {
    try {
      if (payload.eventType === 'DELETE') {
        if (navigator.onLine) fetchInitialData();
        return;
      }

      const row = payload.new;
      if (!row) return;
      await db.upsertStudent(rowToStudent(row));
      state.students = await db.getAllStudents();
      refreshCurrentTabView();
    } catch (err) {
      console.warn('[Realtime] فشل معالجة تحديث طالب فوري', err);
    }
  }

  /**
   * *** UPDATE FIX (تحديث إجباري ذكي — مُعدَّل بعد المراجعة) ***
   * التوست الاختياري القديم شِيل. السبب: التطبيق ده حساس جدًا لفروق
   * النسخة بين الأجهزة، لأن منطق المزامنة نفسه (rank/merge/push) لازم
   * يشتغل بنفس الكود بالظبط على كل جهاز، وإلا رجعنا لنفس مشكلة
   * "شغال في جهاز ومش شغال في التاني". فـ"توست ممكن يتجاهله حد لساعات"
   * مش حل كافي لتطبيق حضور/درجات.
   *
   * السلوك الجديد:
   *   1. أي service worker جديد بيتكتشف → يتفعّل في الخلفية فورًا
   *      (SKIP_WAITING) زي الأول، من غير ما يأثر على الصفحة المفتوحة.
   *   2. فحص دوري لوجود نسخة أحدث: كل ساعة + كل ما التاب يظهر (visible)
   *      + فورًا عند استعادة الاتصال بالنت (online) — عشان أسرع اكتشاف.
   *   3. أول ما النسخة الجديدة تبقى هي المتحكمة (controllerchange)،
   *      بنعمل reload تلقائي **إجباري**، مش اختياري. عشان منقطعش عمل
   *      السكرتيرة في نص كتابة درجة أو تعديل جلسة، بنستنى لحد ما مفيش
   *      مودال شغال فعليًا (بحد أقصى بسيط للانتظار)، مع توست بسيط
   *      يوضّح إن التحديث هيحصل تلقائيًا.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {

        // لو فيه نسخة "waiting" أصلاً وقت ما فتحنا → فعّلها في الخلفية.
        if (reg.waiting) {
          reg.waiting.postMessage('SKIP_WAITING');
        }

        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              // نسخة جديدة خلصت التنزيل — فعّلها في الخلفية (بدون reload لسه).
              nw.postMessage('SKIP_WAITING');
            } else if (nw.state === 'activated') {
              console.info('[SW] Cache updated.');
            }
          });
        });

        // فحص دوري يجبر المتصفح يطلب sw.js من السيرفر تاني (مش من الكاش)
        // بدل ما يستنى الفحص التلقائي البطيء.
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000); // كل ساعة

        // كل ما المستخدم يرجّع فتح/يظهر التاب، افحص فورًا كمان.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });

        // *** إضافة: افحص فورًا كمان عند استعادة الاتصال بالنت، عشان
        // النسخة الجديدة توصل بأسرع ما يمكن بدل ما تستنى الفحص الساعي. ***
        window.addEventListener('online', () => reg.update().catch(() => {}));

      }).catch((err) => console.warn('[SW] Registration failed', err));

      // النسخة الجديدة بقت شغالة فعليًا (controllerchange) → reload
      // إجباري ذكي، مش توست اختياري.
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        forceUpdateReload();
      });

      navigator.serviceWorker.ready.then((reg) => {
        if ('sync' in reg) reg.sync.register('sayyad-sync-queue').catch(() => {});
      }).catch(() => {});

      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SAYYAD_TRIGGER_SYNC') triggerSync();
      });
    });
  }

  /**
   * بيرجع true لو فيه مودال فيه "شغل حي" للمستخدم (إدخال بيانات لسه ما
   * اتحفظتش) لازم نستنى يقفل قبل ما نعمل reload إجباري بسببه.
   * reportExpandModal اتعمد استبعاده عمدًا لأنه عرض فقط (مفيش إدخال بيانات).
   */
  function isBlockingModalOpen() {
    return [els.editSessionModal, els.addStudentModal, els.confirmModal]
      .filter(Boolean)
      .some((modal) => !modal.classList.contains('hidden'));
  }

  /**
   * *** UPDATE FIX — Reload إجباري ذكي ***
   * بيوري توست بسيط يوضّح إن التحديث هيحصل تلقائيًا (مفيش زرار "لاحقًا")،
   * وبعدين بيعمل window.location.reload() فورًا — إلا لو فيه مودال شغال
   * فعليًا (زي تعديل جلسة أو إضافة طالب)، وقتها بيستنى لحد ما يتقفل،
   * بحد أقصى MAX_WAIT_MS عشان مانستناش للأبد لو المستخدم ناسي مودال فاتح.
   */
  function forceUpdateReload() {
    const MAX_WAIT_MS       = 30000; // أقصى انتظار قبل ما نجبر الـ reload برضه
    const CHECK_INTERVAL_MS = 1000;
    const startedAt         = Date.now();

    if (els.toastContainer) {
      const toast = document.createElement('div');
      toast.className = 'toast toast-info';
      toast.innerHTML = `<span>🔄</span><span>تم رفع نسخة جديدة من التطبيق — جاري التحديث تلقائيًا...</span>`;
      els.toastContainer.appendChild(toast);
    }

    const tryReload = () => {
      const blocked  = isBlockingModalOpen();
      const timedOut = (Date.now() - startedAt) >= MAX_WAIT_MS;
      if (!blocked || timedOut) {
        window.location.reload();
        return;
      }
      setTimeout(tryReload, CHECK_INTERVAL_MS);
    };

    // إمهال بسيط عشان التوست يبان قبل الـ reload المباشر لو مفيش عمل شغال.
    setTimeout(tryReload, 600);
  }

  /* ===================================================================
     ATTENDANCE VIEW — RENDERING
     =================================================================== */

  function buildGroupChips() {
    const groups = Array.from(new Set(state.students.map((s) => s.group).filter(Boolean))).sort();
    els.groupChips.innerHTML = '<button class="chip active" data-group="all">الكل</button>' +
      groups.map((g) => `<button class="chip" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    $$('.chip', els.groupChips).forEach((c) => {
      c.classList.toggle('active', c.dataset.group === state.activeGroup);
    });
    populateStudentsFilters();
  }

  function getFilteredStudents() {
    let list = state.students;
    if (state.activeGroup !== 'all') {
      list = list.filter((s) => s.group === state.activeGroup);
    }
    if (state.studentsFilterBranch) {
      list = list.filter((s) => (s.branch || '') === state.studentsFilterBranch);
    }
    if (state.studentsFilterYear) {
      list = list.filter((s) => (s.year || '') === state.studentsFilterYear);
    }
    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.name.toLowerCase().includes(q) ||
        String(s.id).toLowerCase().includes(q)
      );
    }
    return list;
  }

  /**
   * تعبئة قايمتي "السنتر" و"المرحلة الدراسية" في صفحة الطلاب.
   * بتاخد القيم من إعدادات المركز (settings) لو موجودة، وإلا من قيم
   * الطلاب الفعلية الموجودة فعلاً — عشان القايمة تفضل مفيدة حتى لو
   * الإعدادات لسه فاضية.
   */
  function populateStudentsFilters() {
    if (!els.studentsFilterBranch || !els.studentsFilterYear) return;

    const settingsBranches = (state.settings && state.settings.branches) || [];
    const settingsYears    = (state.settings && state.settings.years)    || [];

    const branchesFromStudents = Array.from(new Set(state.students.map((s) => s.branch).filter(Boolean))).sort();
    const yearsFromStudents    = Array.from(new Set(state.students.map((s) => s.year).filter(Boolean))).sort();

    const branches = settingsBranches.length > 0 ? settingsBranches : branchesFromStudents;
    const years    = settingsYears.length    > 0 ? settingsYears    : yearsFromStudents;

    populateSelect(els.studentsFilterBranch, branches, '— كل السنتر —');
    populateSelect(els.studentsFilterYear,   years,    '— كل المراحل —');

    els.studentsFilterBranch.value = state.studentsFilterBranch;
    els.studentsFilterYear.value   = state.studentsFilterYear;
  }

  /**
   * بترجع آخر سجل لهذا الطالب اليوم (أي حالة، شامل 'removed') — يستخدمها
   * منطق الحفظ (handlePresentClick) عشان يعرف الـ recordId الصحيح لإعادة
   * استخدامه بدل ما ينشئ سجل مكرر يتعارض مع الـ tombstone القديم.
   */
  function getTodayAnyRecordForStudent(studentId) {
    const today = todayKey();
    const candidates = state.records.filter(
      (r) => String(r.studentId) === String(studentId) && r.dateKey === today
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    return candidates[0];
  }

  /**
   * *** BUGFIX (Tombstone) *** سجل بحالة 'removed' معناه "الطالب اتحدد
   * غائب صراحةً" — ده مش سجل حضور نشط، فلازم شاشة الطلاب (وشرط تعطيل
   * الأزرار) تتعامل معاه كأن مفيش سجل نشط خالص (تسمح بالضغط على "حاضر"
   * من جديد بشكل طبيعي، بدل ما يفضل الكارت واقف على حالة مش متعرّفة).
   */
  function getTodayActiveRecordForStudent(studentId) {
    const record = getTodayAnyRecordForStudent(studentId);
    if (record && record.status === 'removed') return null;
    return record;
  }

  function renderStudentsList() {
    const list = getFilteredStudents();
    els.studentsList.innerHTML = '';

    if (list.length === 0) {
      els.noResults.classList.remove('hidden');
      return;
    }
    els.noResults.classList.add('hidden');

    const frag = document.createDocumentFragment();
    list.forEach((student) => frag.appendChild(buildStudentCard(student)));
    els.studentsList.appendChild(frag);
  }

  function buildStudentCard(student) {
    const node = els.studentCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.student-card');
    card.dataset.id = student.id;

    node.querySelector('.student-avatar').textContent = initials(student.name);
    node.querySelector('.student-name').textContent   = student.name;
    node.querySelector('.student-id').textContent     = student.id;
    node.querySelector('.tag-group').textContent      = student.group || '—';

    const branchEl = node.querySelector('[data-role="studentBranch"]');
    const phoneEl  = node.querySelector('[data-role="studentPhone"]');
    const subSep   = node.querySelector('[data-role="subSep"]');
    const hasBranch = !!student.branch;
    const hasPhone  = !!student.phone;
    // --- الأكواد الجديدة لإضافة اليوم والموعد ---
    const dayEl = node.querySelector('[data-role="studentDay"]');
    const timeEl = node.querySelector('[data-role="studentTime"]');
    const scheduleRow = node.querySelector('[data-role="scheduleRow"]');

    const hasDay = !!student.day;
    const hasTime = !!student.time;

    // تحويل "م" إلى "PM" و "ص" إلى "AM"
    let timeFormatted = '';
    if (hasTime) {
      timeFormatted = student.time.replace('م', 'PM').replace('ص', 'AM');
    }

    if (dayEl) dayEl.textContent = hasDay ? student.day : '';
    if (timeEl) timeEl.textContent = hasTime ? timeFormatted : '';

    // إخفاء الصف بالكامل إذا لم يكن الطالب مسجلاً في يوم أو موعد
    if (scheduleRow) {
      scheduleRow.classList.toggle('hidden', !(hasDay || hasTime));
    }
    // --------------------------------------------
    branchEl.textContent = hasBranch ? student.branch : '';
    phoneEl.textContent  = hasPhone ? formatPhoneDisplay(student.phone) : '';
    subSep.classList.toggle('hidden', !(hasBranch && hasPhone));

    if (student.syncStatus === 'pending_creation') {
      const tags = node.querySelector('.student-tags');
      const pendingTag = document.createElement('span');
      pendingTag.className = 'tag tag-id';
      pendingTag.textContent = '🆕 بانتظار المزامنة';
      tags.appendChild(pendingTag);
    }

    const hwMaxInput   = node.querySelector('[data-field="homeworkMax"]');
    const examMaxInput = node.querySelector('[data-field="examMax"]');
    if (hwMaxInput)   hwMaxInput.value   = CONFIG.DEFAULT_HOMEWORK_MAX;
    if (examMaxInput) examMaxInput.value = CONFIG.DEFAULT_EXAM_MAX;

    const existingRecord = getTodayActiveRecordForStudent(student.id);
    const statusPill     = node.querySelector('[data-role="statusPill"]');
    const draftConfirm   = node.querySelector('[data-role="draftConfirm"]');
    const draftTime      = node.querySelector('[data-role="draftTime"]');
    const presentBtn     = node.querySelector('[data-action="present"]');
    const saveBtn        = node.querySelector('[data-action="save"]');

    if (existingRecord) {
      const hw    = node.querySelector('[data-field="homeworkGrade"]');
      const hwM   = node.querySelector('[data-field="homeworkMax"]');
      const ex    = node.querySelector('[data-field="examGrade"]');
      const exM   = node.querySelector('[data-field="examMax"]');
      const notes = node.querySelector('[data-field="notes"]');
      if (existingRecord.homeworkGrade != null) hw.value    = existingRecord.homeworkGrade;
      if (existingRecord.homeworkMax   != null) hwM.value   = existingRecord.homeworkMax;
      if (existingRecord.examGrade     != null) ex.value    = existingRecord.examGrade;
      if (existingRecord.examMax       != null) exM.value   = existingRecord.examMax;
      if (existingRecord.notes)                 notes.value = existingRecord.notes;

      if (existingRecord.status === 'draft') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.disabled = false;
        updateStatusPill(statusPill, 'draft');
      } else if (existingRecord.status === 'pending' || existingRecord.status === 'failed') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        saveBtn.innerHTML = '<span>📤</span> تم الإرسال للاعتماد';
        saveBtn.disabled = true;
        updateStatusPill(statusPill, 'pending');
      } else if (existingRecord.status === 'approved' || existingRecord.status === 'synced') {
        card.classList.add('draft-active');
        presentBtn.classList.add('active');
        presentBtn.disabled = true;
        draftConfirm.classList.remove('hidden');
        if (existingRecord.checkinAt) {
          draftTime.textContent = `في ${new Date(existingRecord.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
        }
        hw.disabled = true; hwM.disabled = true;
        ex.disabled = true; exM.disabled = true;
        notes.disabled = true;
        saveBtn.innerHTML = '<span>✅</span> تم الاعتماد';
        saveBtn.disabled = true;
        updateStatusPill(statusPill, existingRecord.status);
      }
    } else {
      saveBtn.disabled = true;
      updateStatusPill(statusPill, null);
    }

    return node;
  }

  function updateStatusPill(pillEl, status) {
    pillEl.classList.remove('status-none', 'status-draft', 'status-pending', 'status-approved');
    if (status === 'draft') {
      pillEl.classList.add('status-draft');
      pillEl.textContent = 'تم تسجيل الدخول';
    } else if (status === 'pending' || status === 'failed') {
      pillEl.classList.add('status-pending');
      pillEl.textContent = 'بانتظار الاعتماد';
    } else if (status === 'approved' || status === 'synced') {
      pillEl.classList.add('status-approved');
      pillEl.textContent = 'تم الاعتماد';
    } else {
      pillEl.classList.add('status-none');
      pillEl.textContent = 'لم يُسجَّل بعد';
    }
  }

  function handleStudentListClick(e) {
    const card = e.target.closest('.student-card');
    if (!card) return;
    const studentId = card.dataset.id;

    if (e.target.closest('[data-action="present"]')) {
      handlePresentClick(card, studentId);
      return;
    }
    if (e.target.closest('[data-action="save"]')) {
      handleSendForApproval(card, studentId);
    }
  }

  async function handlePresentClick(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const presentBtn   = card.querySelector('[data-action="present"]');
    const saveBtn      = card.querySelector('[data-action="save"]');
    const draftConfirm = card.querySelector('[data-role="draftConfirm"]');
    const draftTime    = card.querySelector('[data-role="draftTime"]');
    const statusPill   = card.querySelector('[data-role="statusPill"]');

    const existing = getTodayActiveRecordForStudent(studentId);
    if (existing && (existing.status === 'pending' || existing.status === 'failed')) {
      showToast(`${student.name} تم إرساله للاعتماد مسبقًا`, 'info');
      return;
    }
    // *** BUGFIX (السبب الجذري للمشكلة): زرار "حاضر" كان بيسمح بإعادة
    // كتابة سجل معتمد بالفعل (approved/synced) بحالة 'draft' على نفس
    // الـ recordId — وده كان بيمسح اعتماد الأدمن ويرجّع السجل pending
    // تاني بعد المزامنة، حتى لو الداتا بيز كانت متأكدة إنه approved.
    // الحماية القديمة كانت بس تعطيل الزرار في الواجهة (UI)، لكن شاشة
    // الطلاب مش بتتحدث تلقائيًا لما سجل يتغير من جهاز/تاب تاني، فالزرار
    // كان بيفضل شغال بالغلط. الحماية هنا في منطق الحفظ نفسه تمنع المشكلة
    // حتى لو الواجهة متأخرة في التحديث. ***
    if (existing && (existing.status === 'approved' || existing.status === 'synced')) {
      showToast(`${student.name} تم اعتماد حضوره بالفعل — لا يمكن التعديل`, 'info');
      // نعيد رسم الكارت فورًا عشان الواجهة تتزامن مع الحالة الحقيقية
      renderStudentsList();
      return;
    }

    const now = Date.now();

    // *** BUGFIX (Tombstone): لو آخر سجل لهذا الطالب اليوم كان 'removed'
    // (اتحدد غائب قبل كده)، لازم نعيد استخدام نفس الـ recordId بدل ما
    // ننشئ سجل جديد منفصل — عشان يفضل سجل واحد بس لكل طالب/يوم (وده
    // الافتراض اللي مبني عليه db.getRecordByStudentAndDate / mergeServerRecord).
    // لو أنشأنا recordId جديد، هيبقى عندنا سجلين متعارضين لنفس الطالب/اليوم
    // (القديم removed + الجديد draft) وهيحصل تضارب دايم بينهم مع كل مزامنة.
    const anyRecordToday = getTodayAnyRecordForStudent(studentId);
    const reusableRecord = existing || anyRecordToday; // existing already excludes removed

    const record = {
      recordId:      reusableRecord ? reusableRecord.recordId : uid('rec'),
      studentId:     student.id,
      studentName:   student.name,
      group:         student.group  || '',
      branch:        student.branch || '',
      year:          student.year   || '',
      day:           student.day    || '',
      time:          student.time   || '',
      checkinAt:     existing ? existing.checkinAt : now,
      homeworkGrade: null,
      homeworkMax:   CONFIG.DEFAULT_HOMEWORK_MAX,
      examGrade:     null,
      examMax:       CONFIG.DEFAULT_EXAM_MAX,
      notes:         '',
      status:        'draft',
      dateKey:       todayKey(),
      createdAt:     existing ? existing.createdAt : now,
      updatedAt:     now,
    };

    await db.upsertRecord(record);
    state.records = await db.getAllRecords();

    card.classList.add('draft-active');
    presentBtn.classList.add('active');
    draftConfirm.classList.remove('hidden');
    const timeLabel = new Date(record.checkinAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    draftTime.textContent = `في ${timeLabel}`;
    saveBtn.disabled = false;
    updateStatusPill(statusPill, 'draft');

    vibrate([15, 10, 15]);
    updatePendingBadge();
  }

  async function handleSendForApproval(card, studentId) {
    const student = state.students.find((s) => String(s.id) === String(studentId));
    if (!student) return;

    const saveBtn    = card.querySelector('[data-action="save"]');
    const statusPill = card.querySelector('[data-role="statusPill"]');

    const existing = getTodayActiveRecordForStudent(studentId);
    if (!existing || existing.status !== 'draft') {
      showToast('من فضلك سجّل الحضور أولاً (اضغط حاضر)', 'error');
      return;
    }

    const homeworkGrade = card.querySelector('[data-field="homeworkGrade"]').value;
    const examGrade     = card.querySelector('[data-field="examGrade"]').value;
    const notes         = card.querySelector('[data-field="notes"]').value.trim();

    const updated = {
      ...existing,
      homeworkGrade: homeworkGrade === '' ? null : Number(homeworkGrade),
      homeworkMax:   CONFIG.DEFAULT_HOMEWORK_MAX,
      examGrade:     examGrade     === '' ? null : Number(examGrade),
      examMax:       CONFIG.DEFAULT_EXAM_MAX,
      notes,
      status:    'pending',
      updatedAt: Date.now(),
    };

    await db.upsertRecord(updated);
    state.records = await db.getAllRecords();

    saveBtn.innerHTML = '<span>📤</span> تم الإرسال للاعتماد';
    saveBtn.disabled  = true;
    card.classList.add('saved-flash');
    vibrate([20, 30, 20]);

    setTimeout(() => card.classList.remove('saved-flash'), 900);
    updateStatusPill(statusPill, 'pending');
    updatePendingBadge();
    showToast(`تم إرسال ${student.name} للاعتماد بنجاح`, 'success');
  }

  function updatePendingBadge() {
    const pendingCount = state.records.filter(
      (r) => r.status === 'pending' || r.status === 'failed' || r.status === 'draft'
    ).length;

    els.pendingCountDisplay.textContent = pendingCount;
    els.localQueueSummary.classList.toggle('hidden', pendingCount === 0);

    const approvalCount = state.records.filter((r) => r.status === 'pending' || r.status === 'failed').length;
    els.pendingTabBadge.textContent = approvalCount;
    els.pendingTabBadge.classList.toggle('hidden', approvalCount === 0);

    if (els.statPendingApprovals) els.statPendingApprovals.textContent = approvalCount;
  }

  /* ===================================================================
     CHANGE #2 — SMART STUDENT ID GENERATION
     =================================================================== */

  function getIdBaseForYear(year) {
    if (!year) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('ابتدائي')) return CONFIG.ID_BASE_PRIMARY;
    if (year.includes('إعدادي'))  return CONFIG.ID_BASE_PREPARATORY;
    if (year.includes('ثانوي'))   return CONFIG.ID_BASE_SECONDARY;
    return CONFIG.ID_BASE_PRIMARY;
  }

  function buildDynamicRanges() {
    const ranges = {};
    const branches = (state.settings && state.settings.branches) ? state.settings.branches : FALLBACK_SETTINGS.branches;
    const years    = (state.settings && state.settings.years)    ? state.settings.years    : FALLBACK_SETTINGS.years;

    const RANGE_SIZE_PER_BRANCH = 300;
    const BASE_START_ID = 200;

    if (!branches || !years || years.length === 0) return ranges;

    const sizePerYear = Math.floor(RANGE_SIZE_PER_BRANCH / years.length);

    branches.forEach((branch, branchIndex) => {
      ranges[branch] = {};
      const branchStart = BASE_START_ID + (branchIndex * RANGE_SIZE_PER_BRANCH);

      years.forEach((year, yearIndex) => {
        const yearStart = branchStart + (yearIndex * sizePerYear);
        const yearEnd   = (yearIndex === years.length - 1)
                          ? (branchStart + RANGE_SIZE_PER_BRANCH - 1)
                          : (yearStart + sizePerYear - 1);
        ranges[branch][year] = { start: yearStart, end: yearEnd };
      });
    });

    return ranges;
  }

  function getCustomRange(branch, year) {
    const dynamicRanges = buildDynamicRanges();
    const branchRanges  = dynamicRanges[branch];
    if (!branchRanges) return null;
    return branchRanges[year] || null;
  }

  function generateNextStudentId(branch, year) {
    const customRange = getCustomRange(branch, year);

    let start, end;
    if (customRange) {
      start = customRange.start;
      end   = customRange.end;
    } else {
      start = getIdBaseForYear(year);
      end   = start + 999;
    }

    let maxId = start - 1;
    state.students.forEach((s) => {
      const numId = parseInt(s.id, 10);
      if (!isNaN(numId) && numId >= start && numId <= end && numId > maxId) {
        maxId = numId;
      }
    });

    const nextId = maxId + 1;
    return nextId > end ? null : String(nextId);
  }

  function updateIdPreview() {
    const branch = els.newStudentBranch.value;
    const year   = els.newStudentYear.value;

    if (!branch || !year) {
      els.idPreviewValue.textContent = '—';
      return;
    }

    const nextId = generateNextStudentId(branch, year);
    if (nextId === null) {
      els.idPreviewValue.textContent = 'انتهى النطاق المخصص!';
    } else {
      els.idPreviewValue.textContent = nextId;
    }
  }

  /* ===================================================================
     QR CODE SEARCH — مسح QR Code من الكاميرا مباشرة داخل شاشة الطلاب
     ===================================================================
     - المكتبة (html5-qrcode) بتتحمّل lazy أول ما المستخدم يفتح شاشة
       المسح، فمفيش أي تحميل زيادة لو الميزة دي معملهاش استخدام. بعد أول
       استخدام، الـ Service Worker (sw.js) بيكاش الملف تلقائيًا (cache-first
       cross-origin) فهيشتغل أوفلاين كمان من المرة التانية.
     - الماسح بيشتغل بأعلى fps ممكن (10) وبresolution متوسطة عشان يمسك
       الكود بسرعة فائقة من غير أي لاج، وبيوقف نفسه ويتنضف فورًا بمجرد
       ما يلاقي نتيجة أو المستخدم يقفل الشاشة — من غير أي إعادة تحميل
       أو خروج من الصفحة.
     - القيمة اللي بتتقرا من الـ QR بتتحط في خانة البحث الحالية وتشغّل
       نفس منطق getFilteredStudents() الموجود بالظبط (فلترة بالاسم/الكود).
     =================================================================== */

  const QR_LIB_URL = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
  let qrLibLoadPromise = null;
  let qrScannerInstance = null;
  let qrScannerIsRunning = false;

  function loadQrScannerLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    if (qrLibLoadPromise) return qrLibLoadPromise;

    qrLibLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = QR_LIB_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        qrLibLoadPromise = null; // يسمح بمحاولة تانية لاحقًا
        reject(new Error('QR_LIB_LOAD_FAILED'));
      };
      document.head.appendChild(script);
    });

    return qrLibLoadPromise;
  }

  function setQrScanStatus(message, type) {
    if (!els.qrScanHint) return;
    els.qrScanHint.textContent = message;
    els.qrScanHint.classList.remove('qr-scan-status', 'qr-status-error', 'qr-status-success');
    if (type) els.qrScanHint.classList.add('qr-scan-status', `qr-status-${type}`);
  }

  async function openQrScanModal() {
    els.qrScanModal.classList.remove('hidden');
    els.qrScanModal.setAttribute('aria-hidden', 'false');
    setQrScanStatus('جاري تجهيز الكاميرا...', null);

    try {
      await loadQrScannerLib();
    } catch (err) {
      setQrScanStatus('تعذّر تحميل مكوّن المسح. تأكد من الاتصال بالإنترنت أول مرة استخدام.', 'error');
      return;
    }

    // لو الشاشة اتقفلت وهي لسه بتحمّل المكتبة (المستخدم ضغط إغلاق بسرعة)
    if (els.qrScanModal.classList.contains('hidden')) return;

    try {
      qrScannerInstance = new Html5Qrcode('qrReader', { verbose: false });
      await qrScannerInstance.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
            return { width: size, height: size };
          },
        },
        onQrScanSuccess,
        () => { /* فريم من غير كود — تجاهل بصمت، ده متوقع في كل فريم تقريبًا */ }
      );
      qrScannerIsRunning = true;
      setQrScanStatus('وجّه الكاميرا نحو QR Code الخاص بالطالب', null);
    } catch (err) {
      qrScannerIsRunning = false;
      const denied = String(err && err.name || err || '').toLowerCase().includes('notallowed')
        || String(err || '').includes('Permission');
      setQrScanStatus(
        denied
          ? 'تم رفض إذن الكاميرا. برجاء السماح بالوصول للكاميرا من إعدادات المتصفح.'
          : 'تعذّر تشغيل الكاميرا على هذا الجهاز.',
        'error'
      );
    }
  }

  async function onQrScanSuccess(decodedText) {
    if (!qrScannerIsRunning) return; // منع أي نداء مزدوج بعد التوقف
    qrScannerIsRunning = false; // إيقاف فوري لمنع أي مسح إضافي أثناء الإغلاق

    setQrScanStatus('تم العثور على الكود ✓', 'success');
    const studentId = extractStudentIdFromQr(decodedText);

    await stopQrScanner();
    closeQrScanModal();

    // تعبئة خانة البحث بنفس منطق البحث اليدوي وتنفيذ البحث فورًا
    els.studentSearch.value = studentId;
    state.searchQuery = studentId;
    els.clearSearchBtn.classList.toggle('hidden', state.searchQuery.length === 0);
    renderStudentsList();
    els.studentSearch.focus();
  }

  /**
   * الكود المطبوع على QR ممكن يكون رقم الطالب مباشرة (مثال: "1001")، أو
   * رابط فيه الكود كـ query param (مثال: "https://.../?student=1001")،
   * أو نص فيه الرقم متضمّن. الدالة دي بتحاول تستخرج رقم الطالب بأفضل شكل
   * ممكن، ولو معرفتش تستخرج رقم واضح بترجع النص الخام زي ما هو عشان
   * البحث بالاسم النصي يفضل شغال برضه.
   */
  function extractStudentIdFromQr(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return '';

    // حاول تفسيره كرابط فيه query param زي id/student/code
    try {
      const url = new URL(text);
      const candidateKeys = ['id', 'student', 'studentId', 'student_id', 'code'];
      for (const key of candidateKeys) {
        const val = url.searchParams.get(key);
        if (val) return val.trim();
      }
      // لو رابط من غير query param معروف، جرّب آخر جزء من المسار لو رقم
      const pathParts = url.pathname.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && /^\d+$/.test(lastPart)) return lastPart;
    } catch (e) {
      // مش رابط — كمّل عادي
    }

    // لو النص كله أرقام، ده رقم الطالب مباشرة
    if (/^\d+$/.test(text)) return text;

    // غير كده، استخدم النص الخام زي ما هو (يسمح بالبحث بالاسم لو القيمة نصية)
    return text;
  }

  async function stopQrScanner() {
    qrScannerIsRunning = false;
    if (qrScannerInstance) {
      try {
        await qrScannerInstance.stop();
        qrScannerInstance.clear();
      } catch (err) {
        // الماسح ممكن يكون اتوقف بالفعل أو مستخدمش الكاميرا لسه — تجاهل
      }
      qrScannerInstance = null;
    }
  }

  function closeQrScanModal() {
    els.qrScanModal.classList.add('hidden');
    els.qrScanModal.setAttribute('aria-hidden', 'true');
    stopQrScanner();
  }

  /* ===================================================================
     ADD NEW STUDENT (Offline-First)
     =================================================================== */

  function populateSelect(selectEl, options, placeholder) {
    const current = selectEl.value;
    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` +
      (options || []).map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('');
    if (options && options.includes(current)) selectEl.value = current;
  }

  async function openAddStudentModal() {
    state.settings = await db.getAllSettings();
    const settings = (state.settings && Object.keys(state.settings).length > 0)
      ? state.settings : FALLBACK_SETTINGS;

    populateSelect(els.newStudentYear,   settings.years    || FALLBACK_SETTINGS.years,    'اختر الصف');
    populateSelect(els.newStudentBranch, settings.branches || FALLBACK_SETTINGS.branches, 'اختر الفرع');
    populateSelect(els.newStudentDay,    settings.days     || FALLBACK_SETTINGS.days,     'اختر اليوم');
    populateSelect(els.newStudentTime,   settings.times    || FALLBACK_SETTINGS.times,    'اختر الموعد');

    els.newStudentName.value   = '';
    els.newStudentPhone.value  = '';
    els.idPreviewValue.textContent = '—';

    els.addStudentModal.classList.remove('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => els.newStudentName.focus(), 100);
  }

  function closeAddStudentModal() {
    els.addStudentModal.classList.add('hidden');
    els.addStudentModal.setAttribute('aria-hidden', 'true');
  }

  async function saveNewStudent() {
    const name   = els.newStudentName.value.trim();
    const phone  = els.newStudentPhone.value.trim();
    const year   = els.newStudentYear.value;
    const branch = els.newStudentBranch.value;
    const day    = els.newStudentDay.value;
    const time   = els.newStudentTime.value;

    if (!name) {
      showToast('⚠️ من فضلك اكتب اسم الطالب', 'error');
      els.newStudentName.focus();
      return;
    }
    if (!year || !branch || !day || !time) {
      showToast('⚠️ يجب اختيار جميع بيانات المجموعة (الصف / الفرع / اليوم / الموعد)', 'error');
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 11) {
      showToast('⚠️ رقم هاتف ولي الأمر غير صحيح — يجب ألا يقل عن 11 رقمًا', 'error');
      els.newStudentPhone.focus();
      return;
    }

    const group  = buildGroupLabel(year, branch);
    const nextId = generateNextStudentId(branch, year);

    if (nextId === null) {
      showToast('⚠️ انتهى النطاق المخصص لهذا السنتر/المرحلة، برجاء مراجعة الإدارة', 'error');
      return;
    }

    const newStudent = {
      id:          nextId,
      name,
      phone:       phoneDigits,
      year,
      branch,
      day,
      time,
      group,
      syncStatus:  'pending_creation',
      createdAt:   Date.now(),
    };

    await db.upsertStudent(newStudent);
    state.students = await db.getAllStudents();

    closeAddStudentModal();
    buildGroupChips();
    renderStudentsList();

    showToast(`✅ تم الحفظ! كود الطالب الجديد: [ ${nextId} ]`, 'success');
    vibrate([20, 30, 20]);

    if (navigator.onLine) triggerSync();
  }

  /* ===================================================================
     SESSION CARDS ARCHITECTURE — replaces per-record approval cards
     =================================================================== */

  function renderApprovalsView() {
    const totalStudents = state.students.length;
    const activeGroups  = new Set(state.students.map((s) => s.group)).size;
    const pendingAll    = state.records.filter((r) => r.status === 'draft' || r.status === 'pending' || r.status === 'failed');
    const today         = todayKey();
    const approvedToday = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    els.statTotalStudents.textContent    = totalStudents;
    els.statActiveGroups.textContent     = activeGroups;
    els.statPendingApprovals.textContent = pendingAll.length;
    els.statApprovedToday.textContent    = approvedToday.length;

    renderSessionCards();
  }

  /**
   * Groups draft/pending/failed records by Branch|Year|Day|Time and
   * renders one session card per group.
   */
  function getSessionGroups() {
    const relevant = state.records.filter(
      (r) => r.status === 'draft' || r.status === 'pending' || r.status === 'failed'
    );

    const groups = {};
    relevant.forEach((r) => {
      const key = `${r.branch || ''}|${r.year || ''}|${r.day || ''}|${r.time || ''}`;
      if (!groups[key]) {
        groups[key] = {
          key,
          branch:  r.branch  || '',
          year:    r.year    || '',
          day:     r.day     || '',
          time:    r.time    || '',
          dateKey: r.dateKey || todayKey(),
          records: [],
          hasFailed: false,
        };
      }
      groups[key].records.push(r);
      if (r.status === 'failed') groups[key].hasFailed = true;
    });

    return groups;
  }

  function renderSessionCards() {
    const groups = getSessionGroups();
    state.sessionGroups = groups;

    let list = Object.values(groups);

    const q = state.approvalsSearchQuery;
    if (q) {
      list = list.filter((g) =>
        g.records.some((r) =>
          (r.studentName || '').toLowerCase().includes(q) ||
          String(r.studentId || '').toLowerCase().includes(q)
        )
      );
    }

    els.approvalsList.innerHTML = '';

    if (list.length === 0) {
      els.noApprovals.classList.remove('hidden');
      els.approveAllBtn.classList.add('hidden');
      return;
    }

    els.noApprovals.classList.add('hidden');
    els.approveAllBtn.classList.add('hidden'); // بطل مربوط بسجل مفرد؛ الاعتماد بقى على مستوى الجلسة

    const frag = document.createDocumentFragment();
    list.forEach((group) => frag.appendChild(buildSessionCard(group)));
    els.approvalsList.appendChild(frag);
  }

  function buildSessionCard(group) {
    const node = els.sessionCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.session-card');
    card.dataset.sessionKey = group.key;

    const titleParts = [group.year, group.branch].filter(Boolean);
    node.querySelector('[data-role="sessionTitle"]').textContent = titleParts.join(' — ') || '—';

    const subParts = [group.day, group.time].filter(Boolean);
    node.querySelector('[data-role="sessionSub"]').textContent = subParts.join(' — ') || '';

    const totalStudents = state.students.filter((s) =>
      (s.branch || '') === group.branch &&
      (s.year   || '') === group.year   &&
      (s.day    || '') === group.day    &&
      (s.time   || '') === group.time
    ).length;
    const attended = group.records.length;
    const absent   = Math.max(0, totalStudents - attended);

    node.querySelector('[data-role="metricTotal"]').textContent    = totalStudents;
    node.querySelector('[data-role="metricAttended"]').textContent = attended;
    node.querySelector('[data-role="metricAbsent"]').textContent   = absent;

    const statusPill = node.querySelector('[data-role="sessionStatusPill"]');
    if (group.hasFailed) {
      statusPill.textContent = '⚠️ فشلت المزامنة';
      statusPill.classList.add('status-failed');
    } else {
      statusPill.textContent = `⏳ ${group.records.length} بانتظار الاعتماد`;
    }

    return node;
  }

  function handleApprovalsListClick(e) {
    const card = e.target.closest('.session-card');
    if (!card) return;
    const sessionKey = card.dataset.sessionKey;

    if (e.target.closest('[data-action="approveSession"]')) {
      approveSession(sessionKey);
    } else if (e.target.closest('[data-action="editSession"]')) {
      openEditSessionModal(sessionKey);
    }
  }

  /* ===================================================================
     EDIT SESSION MODAL
     =================================================================== */

  function openEditSessionModal(sessionKey) {
    const group = (state.sessionGroups || getSessionGroups())[sessionKey];
    if (!group) return;

    state.editingSessionKey = sessionKey;

    const titleParts = [group.year, group.branch].filter(Boolean);
    els.editSessionTitle.textContent = titleParts.join(' — ') || 'تعديل الجلسة';
    const subParts = [group.day, group.time].filter(Boolean);
    els.editSessionSub.textContent = subParts.join(' — ') || '';

    // كل طلاب هذه الجلسة بالظبط، مش بس الحاضرين
    const sessionStudents = state.students.filter((s) =>
      (s.branch || '') === group.branch &&
      (s.year   || '') === group.year   &&
      (s.day    || '') === group.day    &&
      (s.time   || '') === group.time
    );

    const recordByStudentId = {};
    group.records.forEach((r) => { recordByStudentId[String(r.studentId)] = r; });

    // Draft edit state: studentId -> { present, homeworkGrade, homeworkMax, examGrade, examMax, notes, recordId }
    const editState = {};
    sessionStudents.forEach((s) => {
      const rec = recordByStudentId[String(s.id)];
      editState[String(s.id)] = {
        student:       s,
        present:       !!rec,
        recordId:      rec ? rec.recordId : null,
        homeworkGrade: rec && rec.homeworkGrade != null ? rec.homeworkGrade : '',
        homeworkMax:   rec && rec.homeworkMax   != null ? rec.homeworkMax   : CONFIG.DEFAULT_HOMEWORK_MAX,
        examGrade:     rec && rec.examGrade     != null ? rec.examGrade     : '',
        examMax:       rec && rec.examMax       != null ? rec.examMax       : CONFIG.DEFAULT_EXAM_MAX,
        notes:         rec ? (rec.notes || '') : '',
      };
    });

    state.editSessionState = editState;
    state.editSessionGroup = group;

    els.editSessionSearch.value = '';
    renderEditSessionStudentList('');

    els.editSessionModal.classList.remove('hidden');
    els.editSessionModal.setAttribute('aria-hidden', 'false');
  }

  function renderEditSessionStudentList(query) {
    const editState = state.editSessionState || {};
    els.editSessionStudentList.innerHTML = '';

    let ids = Object.keys(editState);
    if (query) {
      ids = ids.filter((id) => {
        const s = editState[id].student;
        return (s.name || '').toLowerCase().includes(query) || String(s.id || '').toLowerCase().includes(query);
      });
    }

    if (ids.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'report-attendee-empty';
      empty.textContent = 'لا توجد نتائج مطابقة';
      els.editSessionStudentList.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    ids.forEach((studentId) => frag.appendChild(buildEditSessionRow(studentId, editState[studentId])));
    els.editSessionStudentList.appendChild(frag);
  }

  function buildEditSessionRow(studentId, entry) {
    const node = els.editSessionRowTemplate.content.cloneNode(true);
    const row  = node.querySelector('.edit-session-row');
    row.dataset.studentId = studentId;

    node.querySelector('[data-role="avatar"]').textContent = initials(entry.student.name);
    node.querySelector('[data-role="name"]').textContent   = entry.student.name;
    node.querySelector('[data-role="idTag"]').textContent  = `#${entry.student.id}`;

    const toggleBtn   = node.querySelector('[data-role="presenceToggle"]');
    const toggleLabel = node.querySelector('[data-role="presenceLabel"]');
    const gradesBlock = node.querySelector('[data-role="gradesBlock"]');

    function applyPresenceUI(present) {
      toggleBtn.classList.toggle('is-present', present);
      toggleLabel.textContent = present ? 'حاضر' : 'غائب';
      gradesBlock.classList.toggle('hidden', !present);
    }
    applyPresenceUI(entry.present);

    toggleBtn.addEventListener('click', () => {
      entry.present = !entry.present;
      applyPresenceUI(entry.present);
    });

    const hwGrade = node.querySelector('[data-field="homeworkGrade"]');
    const exGrade = node.querySelector('[data-field="examGrade"]');
    const notesEl = node.querySelector('[data-field="notes"]');

    hwGrade.value = entry.homeworkGrade;
    exGrade.value = entry.examGrade;
    notesEl.value = entry.notes;

    entry.homeworkMax = CONFIG.DEFAULT_HOMEWORK_MAX;
    entry.examMax      = CONFIG.DEFAULT_EXAM_MAX;

    hwGrade.addEventListener('input', () => { entry.homeworkGrade = hwGrade.value === '' ? '' : Number(hwGrade.value); });
    exGrade.addEventListener('input', () => { entry.examGrade     = exGrade.value === '' ? '' : Number(exGrade.value); });
    notesEl.addEventListener('input', () => { entry.notes         = notesEl.value; });

    return node;
  }

  function closeEditSessionModal() {
    state.editingSessionKey = null;
    state.editSessionState  = null;
    state.editSessionGroup  = null;
    els.editSessionModal.classList.add('hidden');
    els.editSessionModal.setAttribute('aria-hidden', 'true');
  }

  /**
   * Upserts local records to reflect the edited session state.
   * Present students → upsert draft/pending record with grades/notes.
   * Absent students   → *** BUGFIX (Tombstone بدل الحذف الصامت) ***
   *
   * قبل كده: تحويل طالب لـ"غائب" كان بيعمل db.deleteRecord() محلي بس،
   * من غير أي إشارة على Supabase. النتيجة: السجل القديم كان يفضل موجود
   * على السيرفر بحالته القديمة (pending/approved)، وأي جهاز تاني (أو
   * حتى نفس الجهاز) بيعمل مزامنة بعد كده كان "يسحبه" تاني من Supabase
   * ويرجّعه محليًا وكأنه سجل وارد جديد — فالطالب يرجع "حاضر" تلقائيًا
   * من غير قصد، وده كان بيحصل بالذات لو جهاز تاني بعت له نفس السجل
   * القديم أثناء نفس دورة المزامنة.
   *
   * الحل: مفيش حذف فعلي خالص هنا. الطالب اللي بيتحول لـ"غائب" بياخد
   * سجله المحلي حالة صريحة 'removed' (tombstone) بدل ما يتمسح، وده
   * بيترفع على Supabase بنفس الـ record_id (upsert)، فأي جهاز يسحب هذا
   * السجل بعد كده هيلاقيه 'removed' بوضوح، مش هيتعامل معاه كسجل جديد.
   * كل أماكن حساب الحضور/الغياب في التطبيق (طابور الاعتماد، التقارير)
   * بتستثني 'removed' زي ما بتستثني عدم وجود سجل خالص.
   */
  async function saveSessionEdit() {
    const editState = state.editSessionState;
    const group      = state.editSessionGroup;
    if (!editState || !group) return;

    const dateKey = group.dateKey || todayKey();

    for (const studentId in editState) {
      const entry = editState[studentId];

      if (!entry.present) {
        if (entry.recordId) {
          // كان له سجل حضور فعلي قبل كده — نحوّله لـ tombstone بدل
          // الحذف، عشان القرار ده يترفع ويتزامن صح مع باقي الأجهزة.
          const existingRecord = await db.getRecord(entry.recordId);
          if (existingRecord) {
            await db.upsertRecord({
              ...existingRecord,
              status:    'removed',
              updatedAt: Date.now(),
            });
          }
        }
        // لو مكانش له سجل أصلًا (كان غائب فعلًا من البداية) — مفيش داعي
        // ننشئ tombstone لسجل ماكانش موجود، عشان ما نضخّمش عدد السجلات
        // بلا داعي.
        continue;
      }

      const recordId = entry.recordId || uid('rec');
      const record = {
        recordId,
        studentId:     String(entry.student.id),
        studentName:   entry.student.name,
        group:         entry.student.group || '',
        branch:        group.branch,
        year:          group.year,
        day:           group.day,
        time:          group.time,
        checkinAt:     Date.now(),
        homeworkGrade: entry.homeworkGrade === '' ? null : Number(entry.homeworkGrade),
        homeworkMax:   CONFIG.DEFAULT_HOMEWORK_MAX,
        examGrade:     entry.examGrade     === '' ? null : Number(entry.examGrade),
        examMax:       CONFIG.DEFAULT_EXAM_MAX,
        notes:         entry.notes || '',
        status:        'pending',
        dateKey,
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
        parentPhone:   entry.student.phone || '',
      };

      await db.upsertRecord(record);
    }

    state.records = await db.getAllRecords();
    closeEditSessionModal();
    renderApprovalsView();
    updatePendingBadge();
    showToast('تم حفظ تعديلات الجلسة', 'success');

    // *** الرفع فورًا لـ Supabase — لازم السيرفر ياخد الـ tombstone بسرعة
    // عشان الأجهزة التانية ما تسحبش النسخة القديمة (قبل التعديل) وترجّع
    // الطالب حاضر بالغلط في الفترة اللي قبل أول مزامنة دورية. ***
    if (navigator.onLine) triggerSync();
  }

  /**
   * Approves an entire session: marks all its draft/pending/failed
   * records as 'approved', logs absences (Enrolled - Attended), pushes
   * to Supabase, then triggers a full sync.
   */
  async function approveSession(sessionKey) {
    const groups = state.sessionGroups || getSessionGroups();
    const group  = groups[sessionKey];
    if (!group) return;

    openConfirm(
      'اعتماد الجلسة',
      `سيتم اعتماد ${group.records.length} سجل لهذه الجلسة وإرسالها. هل تريد المتابعة؟`,
      async () => {
        for (const record of group.records) {
          await db.updateRecordStatus(record.recordId, 'approved', { approvedAt: Date.now() });
        }

        state.records = await db.getAllRecords();
        renderApprovalsView();
        updatePendingBadge();
        showToast(`تم اعتماد جلسة (${group.records.length} سجل)، جاري الرفع...`, 'success');

        await triggerSync();

        const sessionsToFinalize = {
          [sessionKey]: {
            branch:  group.branch,
            year:    group.year,
            group:   group.records[0] ? group.records[0].group : '',
            day:     group.day,
            time:    group.time,
            dateKey: group.dateKey,
          },
        };
        await finalizeSessionsAndLogAbsences(sessionsToFinalize);
      }
    );
  }

  /**
   * منطق finalize_group: لكل جلسة (سنتر/صف/يوم/موعد/تاريخ) اتقفلت بالاعتماد،
   * بنحسب مين من طلاب المجموعة دي "مش حاضر" (يعني مفيش له سجل حضور معتمد
   * النهاردة)، وندرجهم في جدول absences مباشرة على Supabase.
   *
   * الغياب = (كل طلاب نفس الفرع+الصف+اليوم+الموعد) − (الطلاب اللي جالهم سجل
   * حضور اليوم بأي حالة نشطة: draft/pending/approved/synced) — عشان منسجّلش
   * غياب لطالب لسه بيسجل حضوره فعليًا في جهاز تاني في نفس اللحظة.
   */
  async function finalizeSessionsAndLogAbsences(sessionsToFinalize) {
    const sb = initSupabaseClient();
    if (!sb) return; // أوفلاين أو مش متهيّأ — هيتحسب تاني وقت أقرب مزامنة ناجحة

    for (const key in sessionsToFinalize) {
      const session = sessionsToFinalize[key];
      try {
        // كل طلاب هذه الجلسة بالظبط
        const groupStudents = state.students.filter((s) =>
          (s.branch || '') === session.branch &&
          (s.year   || '') === session.year   &&
          (s.day    || '') === session.day    &&
          (s.time   || '') === session.time
        );
        if (groupStudents.length === 0) continue;

        // الطلاب اللي عندهم سجل حضور (بأي حالة نشطة) اليوم لنفس الجلسة
        const presentIds = new Set(
          state.records
            .filter((r) =>
              r.dateKey === session.dateKey &&
              (r.branch || '') === session.branch &&
              (r.year   || '') === session.year   &&
              (r.day    || '') === session.day    &&
              (r.time   || '') === session.time   &&
              (r.status === 'draft' || r.status === 'pending' ||
               r.status === 'approved' || r.status === 'synced' || r.status === 'failed')
            )
            .map((r) => String(r.studentId))
        );

        const absentStudents = groupStudents.filter((s) => !presentIds.has(String(s.id)));
        if (absentStudents.length === 0) continue;

        const absenceRows = absentStudents.map((s) => ({
          student_id:    Number(s.id),
          student_name:  s.name,
          parent_phone:  s.phone || null,
          student_group: s.group || session.group || null,
          absence_date:  session.dateKey,
        }));

        const { error } = await sb.from('absences').insert(absenceRows);
        if (error) throw error;
      } catch (err) {
        // فشل صامت — منمنعش الاعتماد المحلي من الاكتمال بسبب فشل تسجيل الغياب
        console.warn('[Sync] تعذّر تسجيل الغياب للجلسة:', session, err);
      }
    }
  }


  /* ===================================================================
     TASK 3 — REPORTS ENGINE (Daily Auto-Reset)
     =================================================================== */

  /**
   * Renders the full reports view.
   *
   * Logic:
   *  1. Filter state.records for approved/synced entries with dateKey === today.
   *     (At midnight the date changes → zero results → auto-reset.)
   *  2. Group by composite key: branch|year|day|time.
   *  3. For each group, compute:
   *     - Attended: count of records in this group.
   *     - Total:    count of students in state.students matching the same
   *                 branch + year + day + time.
   *     - Absent:   Total − Attended (floored at 0).
   *  4. Render one report card per group.
   */
  function renderReportsView() {
    const today = todayKey();

    // Display today's date in the header badge
    if (els.reportsTodayLabel) {
      els.reportsTodayLabel.textContent = new Date().toLocaleDateString('ar-EG', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
    }

    // Only today's finalised records
    const todayRecords = state.records.filter(
      (r) => (r.status === 'approved' || r.status === 'synced') && r.dateKey === today
    );

    if (todayRecords.length === 0) {
      els.reportCardsList.innerHTML = '';
      els.noReports.classList.remove('hidden');
      return;
    }
    els.noReports.classList.add('hidden');

    // Group records by Branch|Year|Day|Time
    const groups = {};
    todayRecords.forEach((r) => {
      const key = `${r.branch || ''}|${r.year || ''}|${r.day || ''}|${r.time || ''}`;
      if (!groups[key]) {
        groups[key] = {
          key,
          branch:  r.branch  || '',
          year:    r.year    || '',
          day:     r.day     || '',
          time:    r.time    || '',
          records: [],
        };
      }
      groups[key].records.push(r);
    });

    // Render cards
    els.reportCardsList.innerHTML = '';
    const frag = document.createDocumentFragment();

    Object.values(groups).forEach((group) => {
      // Total students in this exact slot
      const totalStudents = state.students.filter((s) =>
        (s.branch || '') === group.branch &&
        (s.year   || '') === group.year   &&
        (s.day    || '') === group.day    &&
        (s.time   || '') === group.time
      ).length;

      const attended = group.records.length;
      const absent   = Math.max(0, totalStudents - attended);

      frag.appendChild(buildReportCard(group, totalStudents, attended, absent));
    });

    els.reportCardsList.appendChild(frag);

    // Wire up mini search bars (added to DOM above)
    $$('.report-mini-search-input', els.reportCardsList).forEach((input) => {
      input.addEventListener('input', () => {
        const key        = input.closest('.report-card').dataset.groupKey;
        const listEl     = input.closest('.report-card').querySelector('[data-role="attendeeList"]');
        const q          = input.value.trim().toLowerCase();
        const groupObj   = Object.values(groups).find((g) => g.key === key);
        if (groupObj) renderAttendeeList(listEl, groupObj.records, q);
      });
    });

    // Wire up Expand buttons
    $$('.report-expand-btn', els.reportCardsList).forEach((btn) => {
      btn.addEventListener('click', () => {
        const groupKey = btn.closest('.report-card').dataset.groupKey;
        openReportExpandModal(groupKey, groups);
      });
    });
  }

  /**
   * Builds a single report card DOM element.
   */
  function buildReportCard(group, total, attended, absent) {
    const node = els.reportCardTemplate.content.cloneNode(true);
    const card = node.querySelector('.report-card');
    card.dataset.groupKey = group.key;

    // Title: e.g. "الصف الثاني الإعدادي — سنتر السرايا"
    const titleParts = [group.year, group.branch].filter(Boolean);
    node.querySelector('[data-role="groupTitle"]').textContent = titleParts.join(' — ') || '—';

    // Sub: e.g. "الأحد — 04:00 م"
    const subParts = [group.day, group.time].filter(Boolean);
    node.querySelector('[data-role="groupSub"]').textContent = subParts.join(' — ') || '';

    // Metrics
    node.querySelector('[data-role="metricTotal"]').textContent    = total;
    node.querySelector('[data-role="metricAttended"]').textContent = attended;
    node.querySelector('[data-role="metricAbsent"]').textContent   = absent;

    // Attendee list
    const listEl = node.querySelector('[data-role="attendeeList"]');
    renderAttendeeList(listEl, group.records, '');

    return node;
  }

  /**
   * Renders attendee row items into a container, optionally filtered by query.
   */
  function renderAttendeeList(containerEl, records, query) {
    containerEl.innerHTML = '';

    const filtered = query
      ? records.filter((r) =>
          (r.studentName || '').toLowerCase().includes(query) ||
          String(r.studentId || '').toLowerCase().includes(query)
        )
      : records;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'report-attendee-empty';
      empty.textContent = query ? 'لا توجد نتائج مطابقة' : 'لا يوجد حاضرون';
      containerEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'report-attendee-item';
      item.innerHTML = `
        <div class="report-attendee-avatar">${escapeHtml(initials(r.studentName))}</div>
        <span class="report-attendee-name">${escapeHtml(r.studentName || '—')}</span>
        <span class="report-attendee-id">#${escapeHtml(String(r.studentId || ''))}</span>
      `;
      frag.appendChild(item);
    });
    containerEl.appendChild(frag);
  }

  /* ── Expand Modal ── */

  function openReportExpandModal(groupKey, groups) {
    const group = Object.values(groups).find((g) => g.key === groupKey);
    if (!group) return;

    state.reportExpandGroupKey = groupKey;

    // Header info
    const titleParts = [group.year, group.branch].filter(Boolean);
    els.reportExpandTitle.textContent = titleParts.join(' — ') || 'التقرير';
    const subParts = [group.day, group.time].filter(Boolean);
    els.reportExpandSub.textContent = subParts.join(' — ') || '';

    // Metrics inside modal
    const totalStudents = state.students.filter((s) =>
      (s.branch || '') === group.branch &&
      (s.year   || '') === group.year   &&
      (s.day    || '') === group.day    &&
      (s.time   || '') === group.time
    ).length;
    const attended = group.records.length;
    const absent   = Math.max(0, totalStudents - attended);

    els.reportExpandMetrics.innerHTML = `
      <div class="report-metric report-metric-total">
        <span class="report-metric-value">${totalStudents}</span>
        <span class="report-metric-label">إجمالي الطلاب</span>
      </div>
      <div class="report-metric report-metric-attended">
        <span class="report-metric-value">${attended}</span>
        <span class="report-metric-label">حاضر</span>
      </div>
      <div class="report-metric report-metric-absent">
        <span class="report-metric-value">${absent}</span>
        <span class="report-metric-label">غائب</span>
      </div>
    `;

    // Store group records for search re-filtering
    els.reportExpandModal.dataset.groupKey = groupKey;
    // Store the records on the modal element so search can reach them
    els.reportExpandModal._currentRecords  = group.records;

    els.reportExpandSearch.value = '';
    renderExpandModalList(groupKey, '');

    els.reportExpandModal.classList.remove('hidden');
    els.reportExpandModal.setAttribute('aria-hidden', 'false');
  }

  function renderExpandModalList(groupKey, query) {
    const records = els.reportExpandModal._currentRecords || [];
    renderAttendeeList(els.reportExpandList, records, query);
  }

  function closeReportExpandModal() {
    state.reportExpandGroupKey = null;
    els.reportExpandModal._currentRecords = [];
    els.reportExpandModal.classList.add('hidden');
    els.reportExpandModal.setAttribute('aria-hidden', 'true');
  }

  /* ===================================================================
     CONFIRM DIALOG
     =================================================================== */

  function openConfirm(title, message, onConfirm) {
    els.confirmTitle.textContent   = title;
    els.confirmMessage.textContent = message;
    state.pendingConfirmAction     = onConfirm;
    els.confirmModal.classList.remove('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'false');
  }

  function closeConfirmModal() {
    state.pendingConfirmAction = null;
    els.confirmModal.classList.add('hidden');
    els.confirmModal.setAttribute('aria-hidden', 'true');
  }

})();
