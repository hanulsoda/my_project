'use strict';
// The academy site's admin header (dahim.kr admin_header.php: .modern-header, the pin bar and the
// breadcrumb bar), redrawn here because this app runs on its own domain and cannot include the
// PHP header. Menu labels and addresses are copied from admin_header.php ($NAV, $__pins); every
// menu entry goes back to https://dahim.kr. The tool itself sits under 학습관리 › 독법·읽기 as
// "읽기 시선 기록". The user's name is not stored in this app, so the header shows the role only.
// Built with createElement/textContent (no HTML strings). Pure parts are unit-tested.
(function (root) {
  const SITE = 'https://dahim.kr';
  const TOOL = { label: '읽기 시선 기록', href: '/children.html' };
  const ACTIVE_GROUP = 'learning';
  const TOOL_COLUMN = '독법·읽기';

  // Copied from admin_header.php $NAV: [label, path, role?]; role 'admin' = 원장 only, 'teacher' = 강사 only.
  const NAV = [
  { k: 'home', l: '홈', d: '', c: [
    { t: '', i: [
      ['학원 운영', '/admin/workflow_control_tower.php', 'admin'],
      ['학원 OS 콘솔', '/admin/os_console.php', 'admin'],
      ['내 업무', '/admin/workflow_my_tasks.php'],
      ['원장 대시보드', '/admin/dashboard.php', 'admin'],
      ['자동매매봇', '/admin/trading_bot.php', 'admin'],
      ['반 운영 콘솔', '/admin/class_admin.php'],
      ['수업 자동화 관제', '/admin/lesson_autopilot.php', 'admin'],
      ['쓰기 관제', '/admin/lesson_autopilot.php#writing', 'admin'],
      ['자동화 학생화면(미리보기)', '/students/autopilot_omr.php', 'admin'],
      ['모닝 브리프', '/admin/director_brief.php', 'admin'],
      ['일정', '/admin/admin_calendar.php'],
      ['글쓰기', '/admin_write.php'],
    ] },
  ] },
  { k: 'admission', l: '입학·진단', d: '신규 유입 · 진단 · 상담', c: [
    { t: '대입 전략 솔루션', i: [
      ['대입 전략 솔루션 (수시·정시·논술)', '/consulting/counseling_integrated.php'],
      ['학종 세특 분석실', '/consulting/consulting_hakjong.php'],
      ['대입 면접 & 모의면접실', '/consulting/consulting_interview_hub.php'],
      ['AI 자기소개서 첨삭실', '/consulting/consulting_jaso.php'],
      ['대학입시정보', '/college_info/'],
      ['내신 입력 콘솔', '/admin/daeip_console.php', 'admin'],
    ] },
    { t: '유입·상담', i: [
      ['무료 진단', '/free_diagnosis/'],
      ['성장 데이터', '/landing/growth.php'],
      ['SNS 콘텐츠', '/clinic/sns_content/index.php', 'admin'],
      ['상담 검색', '/admin/consultation_search.php'],
      ['상담 슬롯 관리', '/admin/consult_slots.php'],
      ['진단 → 상담 안내 발송', '/admin/funnel_invites.php'],
      ['대입 컨설팅 (구버전)', '/consulting/consulting.php'],
    ] },
    { t: '레벨테스트·초진', i: [
      ['클리닉 원장 대시보드', '/clinic/dashboard/index.php'],
      ['레벨테스트 시작', '/clinic/initial/index.php'],
      ['원장 진료 차트 (초진)', '/clinic/initial/director.php'],
      ['학생 검사 이력', '/clinic/dashboard/student.php'],
      ['운영 모니터링', '/clinic/dashboard/ops.php'],
    ] },
    { t: '정밀 진단', i: [
      ['약점 분석·추천', '/clinic/recommend/index.php'],
      ['처방', '/clinic/prescription/index.php'],
      ['OMR 자동 채점', '/clinic/omr/index.php'],
      ['인지 점검 (원장)', '/clinic/modules/cognitive/director_run.php'],
      ['음독 평가', '/clinic/modules/oral/oral.php'],
      ['쓰기 평가', '/clinic/modules/writing/writing.php'],
      ['설문', '/clinic/modules/survey/index.php', 'admin'],
      ['클리닉 리포트 발송', '/clinic/admin_parent_report.php'],
    ] },
  ] },
  { k: 'students', l: '학생·운영', d: '학생 · 반 · 회계 · 시스템', c: [
    { t: '학생·반', i: [
      ['학생 통합 관리', '/admin/student_hub.php'],
      ['학생 등록·정보', '/admin/student_register.php'],
      ['학생 통합 프로필', '/admin/student_integrated_profile.php'],
      ['상업화 운영센터', '/admin/commercialization_center.php'],
      ['교사 업무판', '/admin/commercial_teacher_board.php'],
      ['외부 데이터 동기화', '/admin/commercial_sync_center.php', 'admin'],
      ['출결 관리', '/admin/attendance.php'],
      ['반편성', '/admin/courses.php'],
    ] },
    { t: '강사·회계', i: [
      ['강사 관리', '/admin/teacher_hub.php', 'admin'],
      ['수납', '/admin/payments.php', 'admin'],
      ['입금 매칭', '/admin/payments_bank.php', 'admin'],
      ['수강생 대장', '/admin/student_ledger.php', 'admin'],
      ['출납 장부', '/admin/admin_settlement.php', 'admin'],
      ['학원·구독 관리', '/admin/commercial_tenant_admin.php', 'admin'],
    ] },
    { t: '보안·자동화·도구', i: [
      ['발송 통제센터', '/admin/notification_control.php', 'admin'],
      ['관리 도구', '/admin/admin_tools.php', 'admin'],
      ['학생 접속·로그인 감시', '/admin/ip_management.php?filter_role=student', 'admin'],
      ['IP 차단·화이트리스트', '/admin/ip_management.php', 'admin'],
      ['권한 통제 센터', '/admin/roles.php', 'admin'],
      ['학생 앱 홈 화면', '/admin/app_home_pin.php', 'admin'],
      ['CRON 자동화 관리', '/admin/cron_manager.php', 'admin'],
      ['부품 창고', '/_design_system/parts.php', 'admin'],
      ['디자인 시방서 빌더', '/_design_system/spec_builder.php', 'admin'],
    ] },
  ] },
  { k: 'class', l: '수업·평가', d: '수업 · 과제 · 시험 · 성적', c: [
    { t: '수업·과제', i: [
      ['과제 배정', '/admin/admin_assign_tasks.php'],
      ['학생 질문함', '/admin/student_help_requests.php'],
      ['출제 스튜디오', '/admin/assignment_studio.php'],
      ['교재 목차·시험대비', '/admin/textbook_toc.php'],
      ['학생 오늘의 학습', '/students/today.php'],
      ['스터디로그', '/studylog/launch.php'],
    ] },
    { t: '시험·출제', i: [
      ['시험 관리', '/admin/admin_exam_list.php'],
      ['어휘 출제', '/admin/admin_voca_dashboard.php'],
      ['OMR 기록', '/admin/admin_omr_records.php'],
      ['평가 폐쇄 루프센터', '/admin/assessment_flow_center.php', 'admin'],
      ['평가 실행 작업함', '/admin/assessment_action_center.php'],
      ['평가 파일럿 관제', '/admin/assessment_pilot_center.php', 'admin'],
      ['모의고사 시뮬레이터', '/admin/exam_simulator.php'],
      ['수능·평가원 문항DB', '/admin/assessment_archive.php'],
      ['기출 원본·텍스트 보기', '/admin/assessment_archive.php#exam-text-library'],
      ['기출 문제 스튜디오', '/admin/assessment_range_builder.php', 'admin'],
      ['고등부·중3 개인화 기출 과제', '/admin/assessment_personal_homework.php', 'admin'],
      ['실제 문항 선지 해설', '/admin/assessment_explanation_admin.php'],
      ['리워드', '/admin/admin_talent_system.php'],
    ] },
    { t: '성적·리포트', i: [
      ['한 달 학습 운영', '/admin/assessment_monthly_manager.php'],
      ['성적 리포트', '/admin/admin_report_view.php'],
      ['학생 진도 상세', '/admin/student_progress_detail.php'],
      ['시험 → 약점카드 자동변환', '/admin/exam_to_srs.php'],
    ] },
  ] },
  { k: 'learning', l: '학습관리', d: '내신·수능 · 메타인지 · 독법을 한곳에서', c: [
    { t: '내신·수능 관리', i: [
      ['내신·수능 학습관리', '/admin/naesin_suneung_management.php', 'admin'],
      ['메타인지 자동 연결', '/admin/learning_metacog_bridge.php', 'admin'],
      ['강사 검수 작업대', '/admin/learning_coach.php'],
      ['밀린 숙제 독촉', '/admin/homework_overdue.php'],
      ['과제 관제탑', '/admin/assignment_control.php'],
      ['조용함 감시', '/admin/silence_watch.php', 'admin'],
      ['DB 용량', '/admin/db_capacity.php', 'admin'],
      ['자동 점검', '/admin/selfcheck.php', 'admin'],
      ['독법 원문·교재', '/admin/learning_materials.php', 'admin'],
      ['자동 처방 규칙', '/admin/learning_rules.php', 'admin'],
      ['상품 설정·도입', '/admin/learning_product_setup.php', 'admin'],
      ['운영·감사 센터', '/admin/learning_system_center.php', 'admin'],
    ] },
    { t: '메타인지 실행', i: [
      ['오늘 한눈에', '/clinic/metacog/admin/daily.php'],
      ['학생 상태·알림', '/clinic/metacog/admin/student_status.php'],
      ['수업 목록', '/clinic/metacog/admin/index.php'],
      ['새 수업·자료 등록', '/clinic/metacog/admin/upload.php'],
      ['원장 검수', '/clinic/metacog/admin/inspector.php'],
      ['PDF 자르기', '/clinic/metacog/admin/pdf_cutter.php'],
    ] },
    { t: '시험·성과', i: [
      ['다가오는 시험', '/clinic/metacog/admin/upcoming_exams.php'],
      ['시험 후 분석', '/clinic/metacog/admin/exam_validation.php'],
      ['학교 기출', '/clinic/exam_archive/admin/index.php'],
      ['반별 대시보드', '/clinic/metacog/admin/class_dashboard.php'],
      ['공부 흔적 갤러리', '/clinic/metacog/admin/proofs_gallery.php'],
      ['학원 KPI', '/clinic/metacog/admin/kpi.php'],
      ['다힘펫 참여', '/admin/pet_metrics.php'],
    ] },
    { t: '독법·읽기', i: [
      ['문장 중심축 운영', '/literacy_training/admin/structure_hub.php', 'admin'],
      ['문장 중심축 수업', '/literacy_training/admin/structure_hub.php', 'teacher'],
      ['읽기 대시보드', '/reading/admin_dashboard.php'],
      ['리드인 도서 라이브러리', '/admin/readin_books.php'],
      ['지문 관리', '/reading/admin_passage_list.php'],
      ['청킹 훈련', '/reading/chunking/chunk_admin.php'],
      ['메타독해', '/reading/metareading.php'],
      ['텍스트짐(훈련)', '/reading/textgym.php'],
      ['요약 훈련 현황', '/reading/admin_summary_train.php'],
      ['국어 훈련 배정', '/reading/admin_drill_assign.php'],
      ['읽기 부담 눈금 현황', '/reading/admin_passage_level.php'],
      ['도표 읽기 훈련 현황', '/reading/admin_table_train.php'],
    ] },
    { t: '기초 읽기', i: [
      ['다힘한글', '/clinic/dahim_hangul/index.php'],
      ['읽기 허브', '/reading/elementary/reading_hub.php'],
      ['ERDI 진단', '/reading/elementary/erdi_admin.php'],
      ['음독·유창성', '/reading/elementary/fluency_admin.php'],
      ['음독 훈련', '/clinic/oral_training/index.php'],
      ['속독', '/clinic/speed_reading/admin_records.php'],
    ] },
    { t: '어휘 학습', i: [
      ['우리말 공부 현황', '/admin/urimal_stats.php'],
      ['우리말 수업팩', '/admin/urimal_lesson_lab.php'],
      ['우리말 시험·문제지', '/admin/urimal_exam_lab.php'],
      ['우리말 회차 배정', '/admin/urimal_assign.php'],
      ['우리말 문항 관리', '/admin/urimal_items.php', 'admin'],
      ['말뭉치 문항 검수', '/admin/nikl_items.php'],
      ['문맥 어휘 시험 내기', '/admin/vocab_context_exam.php'],
      ['낱말 학년 눈금', '/admin/vocab_level.php'],
      ['사전 검색 기록', '/admin/dict_search_log.php'],
      ['어휘·독해 연구소', '/admin/lex_admin.php'],
      ['수업 퀴즈(교실 화면)', '/admin/lex_live.php'],
      ['어휘 학습지(인쇄)', '/admin/lex_sheet.php'],
    ] },
  ] },
  { k: 'content', l: '콘텐츠·교재', d: '문항 · 교재 · 아카데미', c: [
    { t: '콘텐츠 라이브러리', i: [
      ['국어 개념어 관리', '/admin/kor_concept_admin.php'],
      ['국어 문법 관리', '/admin/grammar_admin.php'],
      ['문학 이론 관리', '/admin/literature_theory_admin.php'],
      ['통합 문학 학습 관리', '/admin/literature_unified_admin.php'],
      ['프리미엄 문법 문제 관리', '/admin/korean_admin.php'],
      ['내신 데이터 뷰어', '/admin/neasin_viewer.php'],
      ['지문 난이도 콘솔', '/admin/passage_difficulty.php'],
      ['지문 수업 준비', '/admin/passage_prep.php'],
      ['한자 학습·수업', '/students/hanja/index.php'],
      ['한자 진도·오답', '/admin/hanja_progress.php'],
      ['한자 획순 지정', '/admin/hanja_stroke_editor.php', 'admin'],
      ['스킬 태깅 관리', '/admin/skill_tag_manager.php', 'admin'],
      ['AI 자동 태깅 (Gemini)', '/admin/auto_tag_gemini.php', 'admin'],
      ['텍스트짐 처방', '/admin/textgym_admin.php'],
      ['강사 노트 → 학생 SRS', '/admin/teacher_note.php'],
      ['영상 자료 통합 관리', '/admin/edu_resources_admin.php'],
      ['문해력 트레이너', '/trainer/'],
    ] },
    { t: '교재·이북·인강', i: [
      ['이북 에디터', '/books/ebook_creator.php'],
      ['AI 맞춤 교재', '/books/smart_book.php'],
      ['오답 모음집', '/books/wrong_collection.php'],
      ['교재 배포', '/books/book_distribute.php'],
      ['교재 통계', '/books/book_stats.php'],
      ['PDF 인강 (학생용 보기)', '/students/ebook/index.php'],
      ['동영상 강좌 관리', '/admin/edu_course_admin.php', 'admin'],
      ['동영상 강좌 보기', '/edu_videos/learning/courses.php', 'teacher'],
      ['PDF 인강 자료 업로드', '/admin/ebook_upload.php'],
      ['다힘 PDF 관리', '/admin/dahim_admin.php'],
      ['다힘 PDF 검수', '/admin/dahim_review.php'],
      ['학생 맞춤 학습지 인쇄', '/admin/print_worksheet.php'],
      ['시험대비 요점정리', '/edu_videos/learning/exam_review.php'],
    ] },
    { t: '아카데미 (내신)', i: [
      ['아카데미 대시보드', '/academy/'],
      ['맞춤 문제집', '/academy/workbook.php'],
      ['내신 출제 패턴', '/academy/naesin_patterns.php'],
      ['내신 모의시험', '/academy/naesin_mockexam.php'],
      ['작품 통합', '/academy/work_master.php'],
      ['AI 유사 문항', '/academy/ai_similar.php'],
      ['운영 통계', '/academy/statistics.php'],
      ['아카데미 리포트', '/academy/reports.php'],
    ] },
    { t: '통합 문제 출제', i: [
      ['기출 문제 스튜디오', '/admin/assessment_range_builder.php', 'admin'],
      ['EBS 문제 소스', '/question_bank/index.php'],
      ['EBS 소스 관제탑', '/question_bank/dashboard.php', 'admin'],
      ['내신 문제 소스', '/question_bank_neasin/index.php'],
      ['내신 소스 관제탑', '/question_bank_neasin/dashboard.php', 'admin'],
      ['문항 결함 닥터', '/admin/admin_qbank_doctor.php', 'admin'],
    ] },
  ] },
  { k: 'comm', l: '소통·알림', d: '메시지 · 발송 · 공지', c: [
    { t: '메시지·채팅', i: [
      ['학부모 통합 리포트', '/admin/parent_report_hub.php'],
      ['학부모 계정 발급', '/admin/parent_accounts.php', 'admin'],
      ['학부모 리포트 이력 감사', '/admin/parent_report_audit.php', 'admin'],
      ['학부모 포털 미리보기', '/parents/portal.php', 'admin'],
      ['다힘 채팅 (실시간)', '/admin/chat.php'],
      ['학생 메시지', '/admin/student_inbox.php'],
      ['내 받은편지함', '/admin/my_inbox.php'],
      ['인앱 메시지 보내기', '/admin/admin_broadcast_messages.php'],
    ] },
    { t: '발송·공지·학사', i: [
      ['빠른 발송 (반·학생)', '/admin/teacher_send.php'],
      ['공지 게시판', '/admin/notice_board.php'],
      ['교육 인사이트 작업실', '/admin/naver_encyclopedia_console.php'],
      ['블로그 초안·게시', '/admin/naver_blog_console.php'],
      ['자동 게시 봇', '/admin/notice_bot_console.php', 'admin'],
      ['카카오 알림톡 관리', '/admin/kakao_admin.php', 'admin'],
      ['푸시 알림 발송 (무료)', '/admin/push_admin.php', 'admin'],
      ['반 알람 (산수 잠금)', '/admin/alarm_admin.php', 'admin'],
      ['시험 D-day 관리', '/admin/exam_dday.php'],
      ['QR 출석 화면', '/admin/qr_generate.php'],
    ] },
  ] },
  ];

  // admin_header.php $__pins (자주 쓰는 메뉴), per role.
  const PINS = {
    admin: [['원장 대시보드', '/admin/dashboard.php'], ['반 운영 콘솔', '/admin/class_admin.php'], ['학생 관리', '/admin/student_hub.php'],
      ['출결', '/admin/attendance.php'], ['수납', '/admin/payments.php'], ['발송 통제센터', '/admin/notification_control.php']],
    teacher: [['내 수업', '/admin/admin_index.php'], ['출결', '/admin/attendance.php'], ['반 운영 콘솔', '/admin/class_admin.php'],
      ['과제 배정', '/admin/admin_assign_tasks.php'], ['성적 리포트', '/admin/admin_report_view.php'], ['빠른 발송', '/admin/teacher_send.php']],
  };

  // The app's roles: 'admin' is the academy director (원장), 'teacher' a teacher (강사).
  const ROLE_VIEW = {
    admin: { sub: 'DIRECTOR CONSOLE', who: '원장님', badge: '원장', initial: '원', home: '/admin/dashboard.php' },
    teacher: { sub: 'TEACHER STUDIO', who: '선생님', badge: '강사', initial: '선', home: '/admin/admin_index.php' },
  };
  const GROUP_ICON = { home: 'home', admission: 'file', students: 'users', class: 'monitor', learning: 'brain', content: 'book', comm: 'message' };

  const siteUrl = (path) => SITE + path;
  const roleView = (role) => ROLE_VIEW[role] || ROLE_VIEW.teacher;

  // Menu groups the role may see, as { key, label, desc, cols: [{ title, items: [{ label, href, tool? }] }] }.
  // The tool's own entry is added at the end of 학습관리 › 독법·읽기 (marked tool: true, same-site link).
  function navFor(role) {
    const r = role === 'admin' ? 'admin' : 'teacher';
    return NAV.map((g) => ({
      key: g.k,
      label: g.l,
      desc: g.d,
      cols: g.c.map((c) => {
        const items = c.i.filter(([, , only]) => !only || only === r).map(([label, path]) => ({ label, href: siteUrl(path) }));
        if (g.k === ACTIVE_GROUP && c.t === TOOL_COLUMN) items.push({ label: TOOL.label, href: TOOL.href, tool: true });
        return { title: c.t, items };
      }).filter((c) => c.items.length),
    })).filter((g) => g.cols.length);
  }

  const pinsFor = (role) => (PINS[role === 'admin' ? 'admin' : 'teacher']).map(([label, path]) => ({ label, href: siteUrl(path) }));

  // 빠른 이동: menu entries whose label contains every word of the query (spaces ignored), max `limit`.
  function searchMenu(role, query, limit = 8) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const seen = new Set();
    const out = [];
    for (const g of navFor(role)) {
      for (const c of g.cols) {
        for (const it of c.items) {
          const key = it.label.toLowerCase().replace(/\s+/g, '');
          if (seen.has(it.href) || !words.every((w) => key.includes(w))) continue;
          seen.add(it.href);
          out.push({ ...it, group: g.label });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  // ---- DOM ---------------------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // 24x24 line icons standing in for the site's Font Awesome / Bootstrap icons.
  const ICONS = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    file: 'M6 3h9l4 4v14H6z M14 3v5h5',
    users: 'M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 3 18.5V20 M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M21 20v-1.5a3.5 3.5 0 0 0-2.6-3.4 M15.5 4.6a3.5 3.5 0 0 1 0 6.8',
    monitor: 'M3 4h18v12H3z M8 20h8 M12 16v4',
    brain: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 3v18 M8.5 8.5c1 .7 1 2.3 0 3s-1 2.3 0 3 M15.5 8.5c-1 .7-1 2.3 0 3s1 2.3 0 3',
    book: 'M2 5h6a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2z M22 5h-6a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h7z',
    message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    chevron: 'M6 9l6 6 6-6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4.3-4.3',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    menu: 'M4 6h16 M4 12h16 M4 18h16',
    close: 'M6 6l12 12 M18 6L6 18',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    download: 'M12 4v11 M7 10l5 5 5-5 M5 20h14',
    plus: 'M12 5v14 M5 12h14',
    copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
    warn: 'M12 3.5 2.5 20h19z M12 10v4.5 M12 17.2v.3',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16v-4.5 M12 8v.3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    back: 'M19 12H5 M11 18l-6-6 6-6',
  };
  const FILLED = {
    cap: 'M12 3 1 9l11 6 9-4.9V16h2V9z M5 12.9V17l7 3.8 7-3.8v-4.1L12 17z',
    house: 'M12 3 2 11.5h3V20h5.5v-5.5h3V20H19v-8.5h3z',
  };

  // An inline icon, hidden from assistive tech (the text next to it says what it is).
  function icon(name, size = 16) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const filled = name in FILLED;
    for (const [k, v] of Object.entries({
      viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: `dh-ico dh-ico-${name}`,
      fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor',
      'stroke-width': filled ? 0 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })) svg.setAttribute(k, String(v));
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', filled ? FILLED[name] : ICONS[name]);
    svg.append(path);
    return svg;
  }

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }

  async function logout() {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); } catch { /* leaving anyway */ }
    location.href = '/academy';
  }

  const state = { role: null, crumb: '', parts: null };

  function megaGroup(g, idx) {
    const active = g.key === ACTIVE_GROUP;
    const panelId = `dh-mega-${idx}`;
    const toggle = el('button', { type: 'button', class: 'dh-mega-toggle', 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-current': active ? 'true' : null },
      icon(GROUP_ICON[g.key] || 'book', 15), el('span', {}, g.label), g.key === 'home' ? null : icon('chevron', 11));
    const cols = g.cols.map((c) => el('div', { class: 'dh-mega-col' },
      c.title ? el('div', { class: 'dh-mega-col-title' }, c.title) : null,
      c.items.map((it) => el('a', { class: it.tool ? 'dh-mega-link is-tool' : 'dh-mega-link', href: it.href, 'aria-current': it.tool ? 'page' : null },
        icon(it.tool ? 'eye' : 'book', 15), el('span', {}, it.label), it.tool ? el('span', { class: 'dh-tool-tag' }, '이 도구') : null))));
    const panel = el('div', { class: 'dh-mega-panel', id: panelId, style: `--cols:${g.cols.length}` },
      el('div', { class: 'dh-mega-inner' },
        g.key === 'home' ? null : el('div', { class: 'dh-mega-head' }, el('span', { class: 'dh-mega-head-title' }, icon(GROUP_ICON[g.key] || 'book', 15), g.label),
          g.desc ? el('span', { class: 'dh-mega-head-desc' }, g.desc) : null),
        el('div', { class: 'dh-mega-cols' }, cols)));
    const box = el('div', { class: active ? 'dh-mega-group is-active' : 'dh-mega-group' }, toggle, panel);
    toggle.addEventListener('click', () => setOpen(box, !box.classList.contains('open')));
    return box;
  }

  function setOpen(box, open) {
    for (const g of document.querySelectorAll('.dh-mega-group.open')) {
      if (g === box) continue;
      g.classList.remove('open');
      g.querySelector('.dh-mega-toggle').setAttribute('aria-expanded', 'false');
    }
    if (!box) return;
    box.classList.toggle('open', open);
    box.querySelector('.dh-mega-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // 빠른 이동 (Ctrl K): a small search over the menu entries.
  function quickMove() {
    const btn = el('button', { type: 'button', class: 'dh-cmdk-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: '메뉴 빠른 이동 (Ctrl+K)' },
      icon('search', 13), el('span', {}, '빠른 이동'), el('kbd', {}, 'Ctrl K'));
    const input = el('input', { type: 'search', class: 'dh-cmdk-input', placeholder: '메뉴 이름으로 찾기', 'aria-label': '메뉴 이름으로 찾기', autocomplete: 'off' });
    const results = el('ul', { class: 'dh-cmdk-results', role: 'list' });
    const pop = el('div', { class: 'dh-cmdk-pop', role: 'dialog', 'aria-label': '메뉴 빠른 이동', hidden: true }, input, results);
    const render = () => {
      const found = searchMenu(state.role, input.value);
      results.replaceChildren(...(input.value.trim() === ''
        ? [el('li', { class: 'dh-cmdk-empty' }, '찾을 메뉴 이름을 적어 주세요.')]
        : found.length ? found.map((it) => el('li', {}, el('a', { href: it.href, class: 'dh-cmdk-item' }, el('span', {}, it.label), el('small', {}, it.group))))
          : [el('li', { class: 'dh-cmdk-empty' }, '맞는 메뉴가 없어요.')]));
    };
    const open = (yes) => {
      pop.hidden = !yes;
      btn.setAttribute('aria-expanded', yes ? 'true' : 'false');
      if (yes) { input.value = ''; render(); input.focus(); }
    };
    btn.addEventListener('click', () => open(pop.hidden));
    input.addEventListener('input', render);
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { open(false); btn.focus(); } });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K') && state.role) { e.preventDefault(); open(true); }
    });
    document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) open(false); });
    return el('div', { class: 'dh-cmdk' }, btn, pop);
  }

  function drawer() {
    const panel = el('div', { class: 'dh-drawer', id: 'dh-drawer', role: 'dialog', 'aria-label': '메뉴', hidden: true });
    const btn = el('button', { type: 'button', class: 'dh-burger', 'aria-label': '메뉴 열기', 'aria-expanded': 'false', 'aria-controls': 'dh-drawer' }, icon('menu', 20));
    const close = el('button', { type: 'button', class: 'dh-drawer-close', 'aria-label': '메뉴 닫기' }, icon('close', 20));
    const open = (yes) => {
      panel.hidden = !yes;
      btn.setAttribute('aria-expanded', yes ? 'true' : 'false');
      if (yes) close.focus(); else btn.focus();
    };
    btn.addEventListener('click', () => open(true));
    close.addEventListener('click', () => open(false));
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
    return { btn, panel, close };
  }

  function fillDrawer(d) {
    const v = roleView(state.role);
    const out = el('button', { type: 'button', class: 'dh-logout' }, el('span', {}, 'LOGOUT'), icon('logout', 13));
    out.addEventListener('click', logout);
    d.panel.replaceChildren(
      el('div', { class: 'dh-drawer-head' }, el('span', { class: 'dh-avatar', 'aria-hidden': 'true' }, v.initial),
        el('span', { class: 'dh-who' }, el('strong', {}, v.who), el('small', {}, `${v.badge} · ${v.sub}`)), d.close),
      el('nav', { class: 'dh-drawer-nav', 'aria-label': '다힘 메뉴' }, navFor(state.role).map((g) => el('details', { class: 'dh-acc', open: g.key === ACTIVE_GROUP },
        el('summary', {}, icon(GROUP_ICON[g.key] || 'book', 15), g.label),
        g.cols.map((c) => el('div', { class: 'dh-acc-col' }, c.title ? el('div', { class: 'dh-mega-col-title' }, c.title) : null,
          c.items.map((it) => el('a', { class: it.tool ? 'dh-mega-link is-tool' : 'dh-mega-link', href: it.href, 'aria-current': it.tool ? 'page' : null }, el('span', {}, it.label)))))))),
      out);
  }

  // Draws the header into `mount` (an element at the top of <body>). The role arrives later from
  // /api/me through setRole(); until then only the logo, the bars and LOGOUT are shown.
  function mount(target, { crumb = '' } = {}) {
    const mountEl = typeof target === 'string' ? document.getElementById(target) : target;
    if (!mountEl) return null;
    state.crumb = crumb;
    const brandSub = el('small', {}, '');
    const brand = el('a', { class: 'dh-brand', href: siteUrl(ROLE_VIEW.admin.home) },
      el('span', { class: 'dh-brand-mark', 'aria-hidden': 'true' }, icon('cap', 17)),
      el('span', { class: 'dh-brand-text' }, el('b', {}, 'DAHIM'), brandSub));
    const nav = el('nav', { class: 'dh-nav', 'aria-label': '다힘 메뉴' });
    const user = el('span', { class: 'dh-welcome', hidden: true });
    const out = el('button', { type: 'button', id: 'logout', class: 'dh-logout' }, el('span', {}, 'LOGOUT'), icon('logout', 13));
    out.addEventListener('click', logout);
    const cmdk = quickMove();
    cmdk.hidden = true;
    const d = drawer();
    const header = el('header', { class: 'dh-header' }, brand, nav, cmdk, el('div', { class: 'dh-user' }, user, out), d.btn);
    const pinInner = el('div', { class: 'dh-pin-inner' });
    const pins = el('div', { class: 'dh-pin-bar', hidden: true }, pinInner);
    const crumbHome = el('a', { href: siteUrl(ROLE_VIEW.admin.home) }, icon('house', 14), el('span', {}, '홈'));
    const crumbCur = el('span', { class: 'dh-crumb-current', 'aria-current': 'page' }, crumb);
    const crumbs = el('nav', { class: 'dh-crumb-bar', 'aria-label': '현재 위치' },
      el('div', { class: 'dh-crumb' }, crumbHome, el('span', { class: 'dh-sep', 'aria-hidden': 'true' }, '›'),
        el('a', { href: TOOL.href }, TOOL.label), el('span', { class: 'dh-sep', 'aria-hidden': 'true' }, '›'), crumbCur));
    // The drawer sits outside the header: the header's backdrop-filter would trap a fixed child.
    mountEl.replaceChildren(header, pins, crumbs, d.panel);
    // Icon placeholders in the page markup: <span data-icon="eye" data-icon-size="18"></span>.
    for (const e of document.querySelectorAll('[data-icon]')) {
      if (!e.firstChild) e.append(icon(e.dataset.icon, Number(e.dataset.iconSize) || 16));
    }
    mountEl.classList.add('dh-site-top');
    state.parts = { brand, brandSub, nav, user, cmdk, pins, pinInner, crumbHome, crumbCur, drawer: d };
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const openBox = document.querySelector('.dh-mega-group.open');
      if (openBox) { setOpen(openBox, false); openBox.querySelector('.dh-mega-toggle').focus(); }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.dh-mega-group')) setOpen(null, false); });
    return state.parts;
  }

  // role: 'admin' (원장) or 'teacher' (선생님), from GET /api/me.
  function setRole(role) {
    state.role = role === 'admin' ? 'admin' : 'teacher';
    const p = state.parts;
    for (const e of document.querySelectorAll('[data-admin-only]')) e.hidden = state.role !== 'admin';
    if (!p) return;
    const v = roleView(state.role);
    p.brandSub.textContent = v.sub;
    p.brand.href = siteUrl(v.home);
    p.crumbHome.href = siteUrl(v.home);
    p.nav.replaceChildren(...navFor(state.role).map(megaGroup));
    p.user.replaceChildren(el('span', { class: 'dh-avatar', 'aria-hidden': 'true' }, v.initial), el('strong', {}, v.who), el('span', { class: 'dh-role-badge' }, v.badge));
    p.user.hidden = false;
    p.cmdk.hidden = false;
    p.pinInner.replaceChildren(el('span', { class: 'dh-pin-lab' }, '자주 쓰는 메뉴'), ...pinsFor(state.role).map((pin) => el('a', { class: 'dh-pin', href: pin.href }, pin.label)));
    p.pins.hidden = false;
    fillDrawer(p.drawer);
  }

  function setCrumb(text) {
    state.crumb = text;
    if (state.parts) state.parts.crumbCur.textContent = text;
  }

  const exported = { navFor, pinsFor, searchMenu, ROLE_VIEW, SITE, TOOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, { siteHeader: { ...exported, mount, setRole, setCrumb, logout }, icon });
})(typeof window !== 'undefined' ? window : undefined);
