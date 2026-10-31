// 두 화면(강의 목록, 학습 플레이어)이 함께 쓰는 도우미

// 인터넷으로 들어온 학생은 통과(12시간)가 끝나면 서버가 401로 답합니다. 화면을 다시 불러 로그인 안내를 보여 줍니다.
// 학원 내부망과, 입장 확인을 켜지 않은 서버는 401을 쓰지 않습니다.
{
  const plainFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await plainFetch(...args);
    if (res.status === 401) location.reload();
    return res;
  };
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function fmt(seconds) {
  const s = Math.floor(seconds || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

// 서버를 다시 켜는 중(시놀로지가 502)이거나 인터넷이 끊겼을 때 보여 줄 말
const OFFLINE = "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 해 주세요.";

// 시청 위치와 메모는 학생 각자의 브라우저에 저장됩니다.
const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {  // 저장했으면 true. 저장이 막혔거나(사이트 데이터 차단) 꽉 찬 브라우저는 false
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { cannotSave(); return false; }
  },
};

// 기록을 저장할 수 없는 브라우저: 저장된 줄 알고 메모를 쓰다 잃지 않게 화면 맨 위에 한 번 알립니다.
function cannotSave() {
  if (document.getElementById("storage-warning")) return;
  document.body.prepend(el("p", { id: "storage-warning", class: "storage-warning", role: "alert" },
    "이 브라우저에는 기록(이어 보기·메모·틀린 문제)을 저장할 수 없습니다. 브라우저 설정에서 이 사이트의 데이터(쿠키) 저장을 허용하거나 저장 공간을 비워 주세요."));
}
try { localStorage.setItem("storage-check", "1"); localStorage.removeItem("storage-check"); } catch { cannotSave(); }

// ---- 선생님 열쇠(현황·학원 정리 고치기): 브라우저는 머리글(X-Teacher-Key)에 영문·숫자·기호만 보낼 수 있습니다 ----
// 한글 자판 상태로 친 열쇠(예: rkskek → 가나다)는 받지 않고, 예전에 그렇게 기억한 열쇠는 없는 것으로 봅니다.
const KEY_HINT = "열쇠에 한글이 들어갔습니다. 한/영 키로 영문으로 바꿔 다시 넣어 주세요.";
const keyLooksOk = (key) => /^[\x20-\x7e]+$/.test(key);
const teacherKey = () => { const key = store.get("teacher-key") || ""; return keyLooksOk(key) ? key : ""; };

// ---- 왼쪽 사이드바(보관함·폴더): 강의 목록·내 메모·틀린 문제 복습·현황이 함께 씁니다 ----
// 이어 보기: 다 보지 않은 강의를 최근에 본 순서로 5개
function recentVideos(videos) {
  return videos.map((v) => ({ v, pos: store.get(`pos:${v.id}`) }))
    .filter(({ pos }) => pos && pos.t > 5 && pos.t < pos.d - 5)
    .sort((a, b) => (b.pos.at || 0) - (a.pos.at || 0)).slice(0, 5).map(({ v }) => v);
}

// 새로 올라온 강의: 최근 14일 안에 NAS에 올라온 강의를 최신순으로 10개
function freshVideos(videos) {
  return videos.filter((v) => v.added > Date.now() / 1000 - 14 * 86400).sort((a, b) => b.added - a.added).slice(0, 10);
}

// ---- 공부 기록: 영상이 실제로 재생된 시간(배속과 상관없이 흐른 초)을 날마다 study에 더해 둡니다 ----
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function addStudy(seconds) {
  const days = store.get("study") || {};
  const today = localDay(new Date()), oldest = localDay(new Date(Date.now() - 60 * 86400e3));
  days[today] = Math.round((days[today] || 0) + seconds);
  for (const day of Object.keys(days)) if (day < oldest) delete days[day];  // 두 달 넘은 날은 지웁니다
  store.set("study", days);
}

// 이번 주(월~일) 요일별 공부 시간 막대, 합계, 오늘(오늘 아직이면 어제)까지 며칠째 이어서 공부했는지
function weekCard() {
  const days = store.get("study") || {}, now = new Date();
  const minutes = (d) => Math.round((days[localDay(d)] || 0) / 60);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const week = [...Array(7)].map((_, i) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
  const mins = week.map(minutes), top = Math.max(30, ...mins);
  const span = (m) => (m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`);
  let streak = 0;
  for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (minutes(now) ? 0 : 1)); minutes(d); d.setDate(d.getDate() - 1)) streak++;
  const total = mins.reduce((a, b) => a + b, 0);
  return el("section", { class: "week", "aria-label": "이번 주 공부" },
    el("p", { class: "week-head" }, el("span", {}, "이번 주 공부"), el("strong", {}, span(total))),
    el("div", { class: "bars" }, ...week.map((d, i) => el("span", { class: localDay(d) === localDay(now) ? "day today" : "day" },
      el("span", { class: "bar", "aria-hidden": "true" }, el("span", { style: `height: ${Math.round((mins[i] / top) * 100)}%` })),
      el("span", { class: "label", "aria-hidden": "true" }, "월화수목금토일"[i]),
      el("span", { class: "sr-only" }, `${"월화수목금토일"[i]}요일 ${span(mins[i])}`)))),
    el("p", { class: "streak" }, streak ? `${streak}일째 이어서 공부하는 중` : "오늘 강의를 보면 기록이 시작됩니다"));
}

// 선생님이 고른 '이번 주 강의'(사이드바 맨 위). 한 화면에서 한 번만 불러오고, 선생님이 바꾼 뒤에는 picksLoad = null로 다시.
let picksLoad = null;
function picksSection() {
  const box = el("section", { class: "picks", "aria-label": "이번 주 강의", hidden: "" });
  picksLoad ??= fetch("/api/picks").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  picksLoad.then((picks) => {
    if (!picks?.lectures.length) return;
    // 선생님이 대상 학년을 붙였으면 '내 학년'을 고르게 하고(브라우저에 기억), 그 학년 것과 모든 학년 것만 보여 줍니다.
    const select = el("select", { class: "my-grade", "aria-label": "내 학년" },
      ...["", "중1", "중2", "중3", "고1", "고2", "고3"].map((g) => el("option", { value: g }, g || "모든 학년")));
    select.value = store.get("grade") || "";
    const list = el("ul");
    const show = () => {
      const shown = picks.lectures.filter((l) => !select.value || !l.grade || l.grade === select.value);
      list.replaceChildren(...shown.map((l) => el("li", {}, el("a", { href: `watch.html?id=${l.id}` },
        el("span", { class: "icon i-star", "aria-hidden": "true" }), el("span", { class: "name" }, l.title.split("/").pop()),
        el("span", { class: "n" }, l.grade)))));
      if (!shown.length) list.append(el("li", { class: "picks-note" }, `${select.value} 강의는 아직 없습니다.`));
    };
    select.onchange = () => { store.set("grade", select.value); show(); };
    box.replaceChildren(el("div", { class: "picks-head" }, el("h2", {}, "이번 주 강의"),
                                    ...(picks.lectures.some((l) => l.grade) ? [select] : [])),
      ...(picks.note ? [el("p", { class: "picks-note" }, picks.note)] : []), list);
    show();
    box.hidden = false;
  });
  return box;
}

// 강의 목록의 폴더 화면 주소(#f/2022개정/고1). 폴더 이름의 %·# 같은 글자도 그대로 열리게 바꿔 적습니다.
const folderHash = (path) => `#f/${path.split("/").map(encodeURIComponent).join("/")}`;

// prefix: 강의 목록 화면 안이면 "", 다른 화면이면 "./"(강의 목록으로 가서 그 화면을 엽니다). here: 지금 화면의 링크 주소.
// 폴더는 Finder처럼 세 단계까지 펼칩니다(2022개정 ▸ 고1 ▸ 미래엔). 펼친 폴더는 브라우저에 기억합니다.
// 돌려주는 값: folders(폴더 경로 → 링크), reveal(경로)(그 폴더가 보이게 위 폴더들을 펼침) — 강의 목록이 고른 폴더를 표시할 때 씁니다.
function fillSidebar(videos, { prefix = "./", here = "" } = {}) {
  const total = (key) => savedLists(key).reduce((n, l) => n + l.items.length, 0);
  const link = (href, icon, name, n) => el("a", { href, ...(href === here ? { "aria-current": "page" } : {}) },
    el("span", { class: `icon i-${icon}`, "aria-hidden": "true" }), el("span", { class: "name" }, name),
    el("span", { class: "n" }, n ? n.toLocaleString() : ""));
  const tree = new Map();  // 폴더 경로 → {name, n: 그 아래 모든 강의 수, kids: 하위 폴더 경로}
  for (const v of videos) {
    const parts = v.title.includes("/") ? v.title.split("/").slice(0, -1) : ["기타"];
    for (let depth = 1; depth <= Math.min(parts.length, 3); depth++) {
      const path = parts.slice(0, depth).join("/");
      if (!tree.has(path)) {
        tree.set(path, { name: parts[depth - 1], n: 0, kids: [] });
        if (depth > 1) tree.get(parts.slice(0, depth - 1).join("/")).kids.push(path);
      }
      tree.get(path).n++;
    }
  }
  const opened = new Set(store.get("tree") || []);
  const folders = new Map(), toggles = new Map();
  const show = (path, open) => {
    const t = toggles.get(path);
    if (!t) return;
    t.button.setAttribute("aria-expanded", String(open));
    t.button.setAttribute("aria-label", `${tree.get(path).name} ${open ? "접기" : "펼치기"}`);
    t.sub.hidden = !open;
  };
  const setOpen = (path, open) => {
    if (open) opened.add(path); else opened.delete(path);
    store.set("tree", [...opened]);
    show(path, open);
  };
  const node = (path) => {
    const { name, n, kids } = tree.get(path);
    const a = link(`${prefix}${folderHash(path)}`, "folder", name, n);
    folders.set(path, a);
    if (!kids.length) return el("li", {}, el("div", { class: "row" }, el("span", { class: "disclosure" }), a));
    const sub = el("ul", { class: "sub" }, ...kids.map(node));
    const button = el("button", { type: "button", class: "disclosure", onclick: () => setOpen(path, sub.hidden) });
    toggles.set(path, { button, sub });
    return el("li", {}, el("div", { class: "row" }, button, a), sub);
  };
  const top = [...tree.keys()].filter((path) => !path.includes("/"));
  document.querySelector(".sidebar").replaceChildren(
    el("p", { class: "app-name" }, el("img", { src: "icon-180.png", alt: "", width: "22", height: "22" }), "학습 플레이어"),
    weekCard(),
    picksSection(),
    el("h2", {}, "보관함"),
    el("ul", {}, ...[
      link(`${prefix}#v/recent`, "clock", "이어 보기", recentVideos(videos).length),
      link(`${prefix}#v/new`, "new", "새로 올라온 강의", freshVideos(videos).length),
      link("notes.html", "note", "내 메모", total("notes:")),
      link("review.html", "repeat", "틀린 문제 복습", dueCount(videos)),  // 오늘 복습할 문제 수
      link("move.html", "move", "기기 옮기기", 0),
    ].map((a) => el("li", {}, a))),
    el("h2", {}, "폴더"),
    el("ul", { class: "tree" }, ...top.map(node)));
  for (const path of toggles.keys()) show(path, opened.has(path));
  // 키보드(Finder처럼): ↑↓ 이동, → 펼치기(펼쳐져 있으면 첫 하위 폴더로), ← 접기(접혀 있으면 위 폴더로), Home/End
  const nav = document.querySelector(".sidebar");
  nav.onkeydown = (e) => {
    const a = e.target.closest("a");
    if (!a || e.altKey || e.ctrlKey || e.metaKey) return;
    const links = [...nav.querySelectorAll("a")].filter((x) => x.offsetParent);
    const i = links.indexOf(a), path = [...folders].find(([, x]) => x === a)?.[0];
    const t = toggles.get(path);
    let next = null;
    if (e.key === "ArrowDown") next = links[i + 1];
    else if (e.key === "ArrowUp") next = links[i - 1];
    else if (e.key === "Home") next = links[0];
    else if (e.key === "End") next = links.at(-1);
    else if (e.key === "ArrowRight" && t) { if (t.sub.hidden) setOpen(path, true); else next = folders.get(tree.get(path).kids[0]); }
    else if (e.key === "ArrowLeft" && path) {
      if (t && !t.sub.hidden) setOpen(path, false); else next = folders.get(path.split("/").slice(0, -1).join("/"));
    } else return;
    e.preventDefault();
    next?.focus();
  };
  const reveal = (path) => {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) setOpen(parts.slice(0, depth).join("/"), true);
  };
  return { folders, reveal };
}

// ---- 기기 옮기기: 보낼 기록 모으기와 받은 기록 합치기 ----
// 옮기는 것: 이어 보기(pos:), 메모(notes:), 틀린 문제(wrong:), 퀴즈 점수(score:), 공부 기록(study), 재생 속도(speed).
// 선생님 열쇠와 화면 설정(목록 보기·펼친 폴더 등)은 옮기지 않습니다.
const MOVABLE = /^(pos|notes|wrong|score):[0-9a-f]{12}$/;

function collectRecords() {
  let names = [];
  try { names = Object.keys(localStorage); } catch {}
  return Object.fromEntries(names.filter((k) => MOVABLE.test(k) || k === "study" || k === "speed").map((k) => [k, store.get(k)]));
}

// 받은 기록은 다른 기기가 보낸 것이라 모양을 확인하고, 이 기기 기록을 지우지 않고 합칩니다. 합친 개수를 돌려줍니다.
function mergeRecords(data) {  // 센 수와 failed(하나라도 저장하지 못함)
  const num = (x) => typeof x === "number" && Number.isFinite(x);
  const counts = { pos: 0, notes: 0, wrong: 0, score: 0, study: 0, failed: false };
  const put = (key, value) => { if (!store.set(key, value)) counts.failed = true; };
  for (const [key, value] of Object.entries(data || {})) {
    const kind = key.split(":")[0], mine = store.get(key);
    if (kind === "pos" || kind === "score") {  // 더 나중에 본 진도·푼 점수
      const ok = kind === "pos" ? num(value?.t) && num(value?.d) : num(value?.right) && num(value?.total);
      if (MOVABLE.test(key) && ok && (!mine || (value.at || 0) > (mine.at || 0))) { put(key, value); counts[kind]++; }
    } else if (kind === "notes" && MOVABLE.test(key) && Array.isArray(value)) {  // 메모는 둘 다(같은 시각·글은 한 번)
      const same = (n) => `${n.t}|${n.text || ""}`;
      const got = value.filter((n) => num(n?.t) && typeof (n.text ?? "") === "string");
      const had = new Set((mine || []).map(same));
      const merged = [...new Map([...(mine || []), ...got].map((n) => [same(n), { t: n.t, text: n.text || "" }])).values()].sort((a, b) => a.t - b.t);
      counts.notes += new Set(got.map(same).filter((k) => !had.has(k))).size;  // 이 기기에 없던 메모만 셉니다
      put(key, merged);
    } else if (kind === "wrong" && MOVABLE.test(key) && Array.isArray(value)) {  // 틀린 문제는 복습이 더 나간 쪽
      const items = new Map(wrongItems(key.slice(6)).map((w) => [w.k, w]));
      for (const w of value.map((v) => (typeof v === "string" ? { k: v, stage: 0, due: 0 } : v))) {
        if (typeof w?.k !== "string" || !num(w.stage) || !num(w.due)) continue;
        if (!items.has(w.k)) counts.wrong++;
        if (!items.has(w.k) || w.stage > items.get(w.k).stage) items.set(w.k, { k: w.k, stage: w.stage, due: w.due });
      }
      put(key, [...items.values()]);
    } else if (key === "study" && value && typeof value === "object") {  // 날마다 큰 값: 두 번 받아도 늘지 않게
      const days = store.get("study") || {};
      for (const [day, seconds] of Object.entries(value)) {
        if (/^\d{4}-\d\d-\d\d$/.test(day) && num(seconds) && seconds > (days[day] || 0)) { days[day] = seconds; counts.study++; }
      }
      put("study", days);
    } else if (key === "speed" && num(value) && mine == null) {
      put("speed", value);
    }
  }
  return counts;
}

// 폴더를 옮기거나 이름을 바꾼 강의는 번호가 바뀝니다. 서버가 알려 준 {예전 번호: 새 번호}대로 이 기기의 이어 보기·메모·
// 틀린 문제·점수를 새 번호로 옮깁니다(새 번호에 이미 기록이 있으면 기기 옮기기처럼 합침). 화면을 열 때마다 한 번 봅니다.
fetch("/api/moves").then((r) => (r.ok ? r.json() : {})).then((moves) => {
  let names = [];
  try { names = Object.keys(localStorage); } catch {}
  for (const key of names) {
    const found = key.match(/^(pos|notes|wrong|score):([0-9a-f]{12})$/), to = found && moves[found[2]];
    if (!to || to === found[2]) continue;
    if (mergeRecords({ [`${found[1]}:${to}`]: store.get(key) }).failed) continue;  // 새 자리에 쓰지 못했으면 예전 기록을 둡니다
    try { localStorage.removeItem(key); } catch {}
  }
}).catch(() => {});

// 메모 하나 지우기(내 메모·플레이어): 지금 저장된 목록에서 같은 시각·글을 지웁니다.
// 화면을 그릴 때 읽어 둔 목록으로 덮어쓰면, 그사이 다른 탭에서 더한 메모가 사라집니다.
function removeNote(videoId, note) {
  const notes = store.get(`notes:${videoId}`) || [];
  const at = notes.findIndex((n) => n.t === note.t && (n.text || "") === (note.text || ""));
  if (at >= 0) notes.splice(at, 1);
  store.set(`notes:${videoId}`, notes);
}

// ---- 퀴즈 카드: 플레이어와 '틀린 문제 복습'이 함께 씁니다 ----
// 틀린 문제는 강의마다 wrong:<영상 번호>에 문제 글로 기억합니다. 빈칸 문제는 답 문장이 같은 것이 있어 지문까지 붙입니다.
const quizKey = (q) => q.question || [q.context, ...q.parts].join(" ");

// 간격 복습: 틀린 문제는 내일 다시, 맞히면 3일 뒤·7일 뒤 다시 내고, 세 번 이어서 맞히면 목록에서 뺍니다.
// 기록은 [{k: 문제 글, stage: 이어서 맞힌 횟수, due: 다시 낼 시각(ms)}]. 예전 기록(문제 글만)은 오늘 낼 문제로 읽습니다.
// '내일'은 달력의 내일입니다: 밤 11시에 틀린 문제도 다음 날 아침에 나옵니다(그날 0시부터 낼 때).
const DAY_MS = 86400e3;
const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);
const daysLater = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return dayStart(d); };
const isDue = (w) => dayStart(w.due) <= Date.now();

function wrongItems(videoId) {
  return (store.get(`wrong:${videoId}`) || []).map((w) => (typeof w === "string" ? { k: w, stage: 0, due: 0 } : w));
}

function markWrong(videoId, key, wrong) {
  // 선생님용 '많이 틀리는 문제' 통계: 강의·문제·맞음/틀림만 보냅니다(서버는 기기마다 처음 푼 결과만 셈). 실패해도 그만.
  fetch("/api/quiz-result", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: videoId, key: key.slice(0, 1000), right: !wrong }) }).catch(() => {});
  let items = wrongItems(videoId);
  const item = items.find((w) => w.k === key);
  if (wrong) {
    if (item) Object.assign(item, { stage: 0, due: daysLater(1) });
    else items.push({ k: key, stage: 0, due: daysLater(1) });
  } else if (item && isDue(item)) {  // 아직 때가 안 된 문제를 미리 맞힌 것(강의 퀴즈에서 다시 풀 때 등)은 세지 않습니다
    item.stage += 1;
    if (item.stage >= 3) items = items.filter((w) => w !== item);
    else item.due = daysLater([0, 3, 7][item.stage]);
  }
  store.set(`wrong:${videoId}`, items);
}

// 강의마다 <prefix><영상 번호>에 저장한 목록(틀린 문제 wrong:, 메모 notes:)을 [{id, items}]로 모읍니다. 빈 목록은 뺍니다.
function savedLists(prefix) {
  let names = [];
  try { names = Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch {}
  return names.map((k) => ({ id: k.slice(prefix.length), items: store.get(k) || [] })).filter((l) => l.items.length);
}

// videos: 지금 강의 목록. 목록에 없는 강의(옮기거나 이름을 바꾼 강의)의 기록은 지우지 않고 세지도 않습니다.
// 목록을 받지 못했으면(빈 목록) 모두 셉니다.
function wrongLists(videos) {
  const listed = new Set(videos.map((v) => v.id));
  return savedLists("wrong:").filter(({ id }) => !listed.size || listed.has(id)).map(({ id }) => ({ id, items: wrongItems(id) }));
}
const dueCount = (videos) => wrongLists(videos).reduce((n, l) => n + l.items.filter(isDue).length, 0);

// q는 4지선다({question, choices, answer, explanation, time?})나 빈칸 문제({context, parts: 글·빈칸 번갈아}).
// onResult(맞았는지)는 보기를 고르거나 '알았어요·몰랐어요'를 누를 때 부르고, replay(q)는 '설명 다시 보기' 요소(없으면 null).
function quizCard(q, n, onResult, replay) {
  if (q.parts) {
    const line = el("p", { class: "blank-line" });
    const show = (open) => line.replaceChildren(...q.parts.flatMap((part, i) =>
      [i ? " " : "", i % 2 ? el("strong", { class: "blank" }, open ? part : "(          )") : part]));
    show(false);
    const judge = el("div", { class: "judge", hidden: "", "aria-live": "polite" });
    const decide = (knew) => {
      judge.replaceChildren(el("p", { class: "feedback" }, knew ? "좋아요!" : "‘틀린 문제 복습’에 넣었어요."));
      onResult(knew);
    };
    judge.append(el("button", { class: "choice", onclick: () => decide(true) }, "알았어요"),
                 el("button", { class: "choice", onclick: () => decide(false) }, "몰랐어요"));
    const reveal = el("button", { class: "choice", onclick: () => { show(true); reveal.hidden = true; judge.hidden = false; } }, "답 보기");
    return el("article", { class: "question" }, el("h3", {}, `Q${n}. 빈칸에 들어갈 말은?`),
      ...(q.context ? [el("blockquote", {}, q.context)] : []), line, reveal, judge);
  }
  const feedback = el("div", { class: "feedback", hidden: "", "aria-live": "polite" });
  const choices = q.choices.map((choice, i) => el("button", {
    class: "choice",
    onclick: () => {
      choices.forEach((b, k) => {
        b.disabled = true;
        if (k === q.answer) b.classList.add("right");
        else if (k === i) b.classList.add("wrong");
      });
      const link = replay(q);
      feedback.replaceChildren(el("strong", {}, i === q.answer ? "정답입니다! " : "아쉬워요. "), q.explanation, ...(link ? [" ", link] : []));
      feedback.hidden = false;
      onResult(i === q.answer);
    },
  }, `${i + 1}. ${choice}`));
  return el("article", { class: "question" }, el("h3", {}, `Q${n}. ${q.question}`), ...choices, feedback);
}
