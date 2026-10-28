// 두 화면(강의 목록, 학습 플레이어)이 함께 쓰는 도우미

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

// 시청 위치와 메모는 학생 각자의 브라우저에 저장됩니다.
const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// ---- 왼쪽 사이드바(보관함·폴더): 강의 목록·내 메모·틀린 문제 복습·현황이 함께 씁니다 ----
const folderOf = (title) => (title.includes("/") ? title.slice(0, title.indexOf("/")) : "기타");

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

// prefix: 강의 목록 화면 안이면 "", 다른 화면이면 "./"(강의 목록으로 가서 그 화면을 엽니다). here: 지금 화면의 링크 주소.
// 돌려주는 값 {folders: Map(폴더 이름 → 링크)}는 강의 목록이 고른 폴더를 표시할 때 씁니다.
function fillSidebar(videos, { prefix = "./", here = "" } = {}) {
  const total = (key) => savedLists(key).reduce((n, l) => n + l.items.length, 0);
  const link = (href, icon, name, n) => el("a", { href, ...(href === here ? { "aria-current": "page" } : {}) },
    el("span", { class: `icon i-${icon}`, "aria-hidden": "true" }), el("span", { class: "name" }, name),
    el("span", { class: "n" }, n ? n.toLocaleString() : ""));
  const counts = new Map();
  for (const v of videos) counts.set(folderOf(v.title), (counts.get(folderOf(v.title)) || 0) + 1);
  const folders = new Map([...counts].map(([name, n]) => [name, link(`${prefix}#f/${name}`, "folder", name, n)]));
  document.querySelector(".sidebar").replaceChildren(
    el("p", { class: "app-name" }, el("img", { src: "icon-180.png", alt: "", width: "22", height: "22" }), "학습 플레이어"),
    weekCard(),
    el("h2", {}, "보관함"),
    el("ul", {}, ...[
      link(`${prefix}#v/recent`, "clock", "이어 보기", recentVideos(videos).length),
      link(`${prefix}#v/new`, "new", "새로 올라온 강의", freshVideos(videos).length),
      link("notes.html", "note", "내 메모", total("notes:")),
      link("review.html", "repeat", "틀린 문제 복습", dueCount()),  // 오늘 복습할 문제 수
    ].map((a) => el("li", {}, a))),
    el("h2", {}, "폴더"),
    el("ul", {}, ...[...folders.values()].map((a) => el("li", {}, a))));
  return { folders };
}

// ---- 퀴즈 카드: 플레이어와 '틀린 문제 복습'이 함께 씁니다 ----
// 틀린 문제는 강의마다 wrong:<영상 번호>에 문제 글로 기억합니다. 빈칸 문제는 답 문장이 같은 것이 있어 지문까지 붙입니다.
const quizKey = (q) => q.question || [q.context, ...q.parts].join(" ");

// 간격 복습: 틀린 문제는 내일 다시, 맞히면 3일 뒤·7일 뒤 다시 내고, 세 번 이어서 맞히면 목록에서 뺍니다.
// 기록은 [{k: 문제 글, stage: 이어서 맞힌 횟수, due: 다시 낼 시각(ms)}]. 예전 기록(문제 글만)은 오늘 낼 문제로 읽습니다.
const DAY_MS = 86400e3;
const isDue = (w) => w.due <= Date.now();

function wrongItems(videoId) {
  return (store.get(`wrong:${videoId}`) || []).map((w) => (typeof w === "string" ? { k: w, stage: 0, due: 0 } : w));
}

function markWrong(videoId, key, wrong) {
  let items = wrongItems(videoId);
  const item = items.find((w) => w.k === key);
  if (wrong) {
    if (item) Object.assign(item, { stage: 0, due: Date.now() + DAY_MS });
    else items.push({ k: key, stage: 0, due: Date.now() + DAY_MS });
  } else if (item && isDue(item)) {  // 아직 때가 안 된 문제를 미리 맞힌 것(강의 퀴즈에서 다시 풀 때 등)은 세지 않습니다
    item.stage += 1;
    if (item.stage >= 3) items = items.filter((w) => w !== item);
    else item.due = Date.now() + [0, 3, 7][item.stage] * DAY_MS;
  }
  store.set(`wrong:${videoId}`, items);
}

// 강의마다 <prefix><영상 번호>에 저장한 목록(틀린 문제 wrong:, 메모 notes:)을 [{id, items}]로 모읍니다. 빈 목록은 뺍니다.
function savedLists(prefix) {
  let names = [];
  try { names = Object.keys(localStorage).filter((k) => k.startsWith(prefix)); } catch {}
  return names.map((k) => ({ id: k.slice(prefix.length), items: store.get(k) || [] })).filter((l) => l.items.length);
}

const wrongLists = () => savedLists("wrong:").map(({ id }) => ({ id, items: wrongItems(id) }));
const dueCount = () => wrongLists().reduce((n, l) => n + l.items.filter(isDue).length, 0);

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
