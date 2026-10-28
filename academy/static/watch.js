const params = new URLSearchParams(location.search);
const id = params.get("id");
const $ = (elementId) => document.getElementById(elementId);
const video = $("video");
video.src = `/media/${id}`;

let chapters = [];  // { start, title, card, bar }
let pages = [];     // { start, item }
let refItems = [];  // { start, item } 시간이 붙은 학원 정리 항목, 시간 순

function seek(t) {
  video.currentTime = t;
  video.play().catch(() => {});
}

function timeButton(t) {
  return el("button", { class: "time", "aria-label": `${fmt(t)}로 이동`, onclick: () => seek(t) }, fmt(t));
}

function notice(text) {
  return el("p", { class: "notice" }, text);
}

// ---- 탭 ----
for (const tab of document.querySelectorAll(".tabs button")) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll(".tabs button")) {
      other.classList.toggle("active", other === tab);
      other.setAttribute("aria-selected", String(other === tab));  // 화면 읽기 프로그램에 열린 탭을 알립니다
    }
    for (const body of document.querySelectorAll(".tab-body")) body.hidden = body.id !== `tab-${tab.dataset.tab}`;
  };
}

// ---- 데이터 불러오기 ----
fetch(`/api/videos/${id}`)
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(render)
  .catch(() => { $("title").textContent = "영상을 찾을 수 없습니다"; });

function render({ title, analysis, references = [] }) {
  document.title = title;
  $("title").textContent = title;
  video.setAttribute("aria-label", title);
  if (!analysis) {
    const msg = "아직 분석되지 않은 영상입니다. 선생님이 분석을 실행하면 요점 정리·페이지·퀴즈가 생깁니다.";
    for (const tab of ["guide", "pages", "quiz", "ask"]) $(`tab-${tab}`).replaceChildren(notice(msg));
    return;
  }
  renderPages(analysis.pages || []);
  setupAsk();
  // 로컬 AI가 대본으로 만든 목차: 챕터 제목·시간만 있고 핵심 내용·퀴즈는 없습니다.
  const toc = (analysis.toc?.chapters || []).map((c) => ({ ...c, points: [] }));
  const tocNotice = () => notice("강의 대본으로 자동으로 만든 목차입니다. 틀릴 수 있습니다. 시간을 누르면 그 장면으로 이동합니다.");
  $("print-btn").hidden = !(analysis.guide || references.length || toc.length);
  if (analysis.guide) {
    renderGuide(analysis.guide, analysis.duration);
    renderQuiz(analysis.guide.quiz);
  } else if (references.length) {
    renderReferences(references);
    renderQuiz(references.flatMap((r) => r.quiz));
    if (toc.length) $("tab-guide").prepend(tocNotice(), ...renderChapters(toc, analysis.duration));  // 학원 정리에는 챕터가 없어 위에 목차
  } else if (toc.length) {
    $("tab-guide").replaceChildren(tocNotice(), ...renderChapters(toc, analysis.duration));
    renderQuiz([]);
  } else {
    const msg = "이 강의는 아직 요점 정리가 없습니다. 페이지는 사용할 수 있습니다.";
    $("tab-guide").replaceChildren(notice(msg));
    $("tab-quiz").replaceChildren(notice(msg));
  }
}

// ---- 요점 정리 + 챕터 점프 ----
function renderGuide(guide, duration) {
  const box = $("tab-guide");
  box.replaceChildren(...(guide.summary ? [el("p", { class: "summary" }, guide.summary)] : []));
  if (guide.overview?.length || guide.glossary?.length) box.append(overviewCard(guide));
  box.append(...renderChapters(guide.chapters, duration));
}

// 영상 아래 챕터 막대와 이전·다음 챕터 버튼을 준비하고, 요점 정리 탭에 넣을 챕터 카드들을 돌려줍니다.
function renderChapters(list, duration) {
  const bar = $("chapter-bar");
  bar.hidden = $("chapter-nav").hidden = list.length === 0;
  chapters = list.map((c, i) => {
    const card = el("article", { class: "chapter" },
      el("h3", {}, timeButton(c.start), " ", c.title),
      el("ul", {}, ...c.points.map((p) => el("li", {}, p))));
    const end = i + 1 < list.length ? list[i + 1].start : duration;
    const segment = el("button", {
      title: `${fmt(c.start)} ${c.title}`,
      "aria-label": `${fmt(c.start)} ${c.title}로 이동`,
      style: `flex-grow: ${Math.max(end - c.start, 1)}`,
      onclick: () => seek(c.start),
    });
    bar.append(segment);
    return { start: c.start, title: c.title, card, bar: segment };
  });
  return chapters.map((c) => c.card);
}

// 이전·다음 챕터: 챕터에 들어온 지 3초가 넘었으면 '이전'은 그 챕터 처음으로 갑니다(음악 앱처럼).
function jumpChapter(step) {
  const now = video.currentTime;
  const i = chapters.findLastIndex((c) => c.start <= now + 0.25);
  const target = step > 0 ? i + 1 : i >= 0 && now - chapters[i].start > 3 ? i : i - 1;
  if (chapters[target]) seek(chapters[target].start);
}
$("prev-chapter").onclick = () => jumpChapter(-1);
$("next-chapter").onclick = () => jumpChapter(1);

// 학원 요점 정리를 바탕으로 만든 강의의 작품 개요(갈래·주제 등)와 핵심 어휘
function overviewCard({ overview = [], glossary = [], sources = [] }) {
  const pairs = (items, key, value) => items.flatMap((item) => [el("dt", {}, item[key]), el("dd", {}, item[value])]);
  const card = el("article", { class: "overview" });
  if (sources.length) card.append(el("p", { class: "sources" }, `학원 요점 정리 바탕: ${sources.join(", ")}`));
  if (overview.length) card.append(el("dl", {}, ...pairs(overview, "name", "value")));
  if (glossary.length) card.append(el("h3", {}, "핵심 어휘"), el("dl", {}, ...pairs(glossary, "term", "meaning")));
  return card;
}

// 이 강의를 위한 요점 정리가 없을 때: 학원이 만든 작품별 요점 정리를 그대로 보여 줍니다(영상 시간 연결 없음).
function renderReferences(references) {
  refItems = [];
  $("tab-guide").replaceChildren(
    notice("학원 요점 정리입니다. 시간을 누르면 그 설명으로 이동합니다. 시간은 대본에서 자동으로 찾은 것이라 가끔 틀릴 수 있고, 시간이 없는 내용은 페이지 탭에서 찾을 수 있습니다."),
    ...references.map(({ source, sections }) => el("article", { class: "overview reference" },
      el("h3", {}, source),
      ...sections.flatMap(({ name, items, times = [] }) => [el("h4", {}, name), el("ul", {}, ...items.map((item, i) => {
        const li = el("li", {}, ...(times[i] == null ? [] : [timeButton(times[i]), " "]), item);
        if (times[i] != null) refItems.push({ start: times[i], item: li });
        return li;
      }))]))));
  refItems.sort((a, b) => a.start - b.start);
}

// ---- 페이지: 교재의 어느 화면을 설명하는지 그림으로 찾아 이동 ----
function renderPages(list) {
  const box = $("tab-pages");
  if (!list.length) {
    box.replaceChildren(notice("페이지 정보가 없습니다. 선생님이 분석을 다시 실행하면 생깁니다."));
    return;
  }
  const grid = el("ul", { class: "pages" });
  pages = list.map((p, n) => {
    const item = el("li", {}, el("button", {
      class: "page",
      "aria-label": `${p.label || `${n + 1}번째 화면`}, ${fmt(p.start)}로 이동`,
      onclick: () => seek(p.start),
    }, el("img", { src: `/api/videos/${id}/pages/${n}.jpg`, alt: "" }),
       ...(p.label ? [el("span", { class: "page-label" }, p.label)] : []),
       el("span", { class: "time" }, fmt(p.start))));
    grid.append(item);
    return { start: p.start, item };
  });
  box.replaceChildren(notice("지금 보고 있는 교재 화면을 찾아 누르면 그 설명으로 이동합니다."), grid);
}

// ---- 복습 퀴즈 ----
// only를 주면 그 문제(quizKey)만 다시 풉니다. 문제 번호는 전체 퀴즈의 번호 그대로입니다.
function renderQuiz(quiz, only = null) {
  const box = $("tab-quiz");
  if (!quiz.length) { box.replaceChildren(notice("이 강의에는 퀴즈가 없습니다.")); return; }
  const keys = new Set(quiz.map(quizKey));
  const savedWrong = () => (store.get(`wrong:${id}`) || []).filter((k) => keys.has(k));
  store.set(`wrong:${id}`, savedWrong());  // 다시 분석해서 없어진 문제는 기록에서 정리합니다
  if (!only) printQuiz(quiz);
  const shown = only ? quiz.filter((q) => only.includes(quizKey(q))) : quiz;
  const choiceCount = shown.filter((q) => q.choices).length;
  let answered = 0, correct = 0;
  const last = store.get(`score:${id}`);
  const lastScore = !only && last ? [el("p", { class: "notice" },
    `지난번 ${last.right}/${last.total} (${new Date(last.at).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })})`)] : [];
  const score = el("p", { class: "score", "aria-live": "polite" });
  const updateScore = () => { score.textContent = `${choiceCount}문제 중 ${answered}문제 풀이 · ${correct}개 정답`; };
  const retryWrong = el("button", { class: "retry", onclick: () => renderQuiz(quiz, savedWrong()) });
  const updateRetry = () => {
    const n = savedWrong().length;
    retryWrong.hidden = n === 0;
    retryWrong.textContent = `틀린 문제만 다시 풀기 (${n}개)`;
  };
  // 학원 정리로 만든 문제는 영상 시간이 없을 수 있습니다.
  const replay = (q) => q.time == null ? null : el("button", { class: "link", onclick: () => seek(q.time) }, `▶ ${fmt(q.time)} 설명 다시 보기`);
  const cards = shown.map((q) => quizCard(q, quiz.indexOf(q) + 1, (right) => {
    if (q.choices) {
      answered++;
      if (right) correct++;
      updateScore();
      // 전체 풀기에서 4지선다를 끝까지 풀면 점수를 기억해 목록에 보여 줍니다('틀린 문제만'은 빼고).
      if (!only && answered === choiceCount) store.set(`score:${id}`, { right: correct, total: choiceCount, at: Date.now() });
    }
    markWrong(id, quizKey(q), !right);
    updateRetry();
  }, replay));
  updateScore();
  score.hidden = choiceCount === 0;
  updateRetry();
  box.replaceChildren(...lastScore, score, ...cards, el("div", { class: "quiz-actions" },
    el("button", { class: "retry", onclick: () => renderQuiz(quiz) }, only ? "전체 문제 풀기" : "다시 풀기"), retryWrong));
}

// ---- 인쇄: 요점 정리 탭은 그대로 찍고, 퀴즈는 문제만 찍은 뒤 마지막 장에 정답(먼저 풀고 맞춰 보게) ----
// 브라우저 메뉴(Ctrl+P)로 찍어도 같도록 인쇄용 퀴즈는 미리 만들어 두고 화면에서만 숨깁니다.
function printQuiz(quiz) {
  const blank = (q) => q.parts.map((part, i) => (i % 2 ? "________" : part)).join(" ");
  const answer = (q) => q.choices
    ? `${q.answer + 1}번 — ${q.explanation || q.choices[q.answer]}`  // 어휘 문제 해설에 이미 뜻이 들어 있어 보기 글은 해설이 없을 때만
    : q.parts.filter((_, i) => i % 2).join(", ");
  $("print-quiz").replaceChildren(...(quiz.length ? [
    el("h2", {}, "복습 퀴즈"),
    ...quiz.map((q, n) => el("section", { class: "print-question" },
      el("h3", {}, `${n + 1}. ${q.question || "빈칸에 들어갈 말은?"}`),
      ...(q.choices ? [el("ol", {}, ...q.choices.map((c) => el("li", {}, c)))]
        : [...(q.context ? [el("blockquote", {}, q.context)] : []), el("p", {}, blank(q))]))),
    el("section", { class: "answers" }, el("h2", {}, "정답"), ...quiz.map((q, n) => el("p", {}, `${n + 1}. ${answer(q)}`))),
  ] : []));
}
$("print-btn").onclick = () => window.print();

// ---- AI에게 질문하기 ----
function linkify(text) {
  const parts = [];
  let from = 0;
  for (const m of text.matchAll(/\[((?:\d+:)?\d{1,2}:\d{2})\]/g)) {
    const t = m[1].split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
    parts.push(text.slice(from, m.index), el("button", { class: "time", onclick: () => seek(t) }, m[1]));
    from = m.index + m[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

function setupAsk() {
  const history = [];
  const form = $("ask-form"), question = $("question"), chat = $("chat");
  const say = (role, text) => {
    const bubble = el("div", { class: `bubble ${role}` }, text);
    chat.append(bubble);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  };
  question.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = question.value.trim();
    if (!text) return;
    const button = form.querySelector("button");
    button.disabled = true;
    say("user", text);
    const reply = say("assistant", "답변을 만드는 중…");
    try {
      const res = await fetch(`/api/videos/${id}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          history: history.slice(-20),
          current_time: $("use-time").checked ? video.currentTime : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `서버 오류 (${res.status})`);
      reply.replaceChildren(...linkify(body.answer));
      history.push({ role: "user", content: text }, { role: "assistant", content: body.answer });
      question.value = "";
    } catch (err) {
      reply.textContent = `답변을 받지 못했습니다. ${err.message}`;
      reply.classList.add("error");
    } finally {
      button.disabled = false;
    }
  };
}

// ---- 메모·북마크 ----
const notesKey = `notes:${id}`;

function renderNotes() {
  const notes = store.get(notesKey) || [];
  $("notes").replaceChildren(...notes.map((n, i) => el("li", {},
    timeButton(n.t),
    el("span", { class: "note-text" }, n.text || "🔖 북마크"),
    el("button", {
      class: "delete",
      "aria-label": `${fmt(n.t)} 메모 삭제`,
      onclick: () => { notes.splice(i, 1); store.set(notesKey, notes); renderNotes(); },
    }, "삭제"))));
  if (!notes.length) $("notes").append(el("li", { class: "notice" }, "아직 메모가 없습니다. 영상을 보다가 기억할 장면에서 추가하세요."));
}

$("note-form").onsubmit = (e) => {
  e.preventDefault();
  const notes = store.get(notesKey) || [];
  notes.push({ t: video.currentTime, text: $("note-text").value.trim() });
  notes.sort((a, b) => a.t - b.t);
  store.set(notesKey, notes);
  $("note-text").value = "";
  renderNotes();
};
renderNotes();

// ---- 재생 속도(브라우저에 기억해 다른 강의에도 씀)와 단축키 ----
function setSpeed(rate) {
  video.playbackRate = video.defaultPlaybackRate = rate;  // 영상을 불러올 때 기본 속도로 되돌아가지 않게 둘 다 바꿉니다
  store.set("speed", rate);
  for (const b of $("speed").children) b.setAttribute("aria-pressed", String(Number(b.dataset.rate) === rate));
}
$("speed").replaceChildren(...[0.8, 1, 1.25, 1.5, 2].map((rate) =>
  el("button", { "data-rate": rate, onclick: () => setSpeed(rate) }, `${rate}×`)));
setSpeed(store.get("speed") || 1);

// 글을 쓰는 중이면 단축키를 쓰지 않습니다. 키보드(Tab)로 버튼에 간 학생의 스페이스는 그 버튼을 누릅니다(퀴즈 보기 고르기 등).
// 영상 자체 단축키보다 먼저 받아(true) 한 번만 움직이게 합니다.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.target.closest("input, textarea, select")) return;
  if (e.key === " " && e.target.closest("button")) return;
  if (e.key === " ") {
    if (!e.repeat) video.paused ? video.play().catch(() => {}) : video.pause();  // 꾹 누르고 있어도 반복하지 않게
  } else if (e.key === "ArrowLeft") video.currentTime = Math.max(0, video.currentTime - 10);
  else if (e.key === "ArrowRight") video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  else if (e.key === "[") jumpChapter(-1);
  else if (e.key === "]") jumpChapter(1);
  else return;
  e.preventDefault();  // 스페이스·화살표로 화면이 움직이지 않게
}, true);

// 마우스로 누른 버튼·링크에는 초점이 남지 않게 해서, 누른 뒤의 스페이스가 영상 재생·멈춤이 되게 합니다.
// 메모 칸에 쓰다가 버튼을 눌렀으면 그 칸에서도 초점을 빼야 스페이스가 칸에 써지지 않습니다.
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("button, a")) return;
  e.preventDefault();
  if (document.activeElement?.matches("input, textarea")) document.activeElement.blur();
});
video.addEventListener("contextmenu", (e) => e.preventDefault());  // 우클릭 '동영상 저장' 메뉴를 숨깁니다

// ---- 이어보기 + 지금 위치 표시 ----
const posKey = `pos:${id}`;
let lastSaved = 0;
const savePosition = () => {
  lastSaved = video.currentTime;
  store.set(posKey, { t: video.currentTime, d: video.duration, at: Date.now() });  // at: 목록의 '이어 보기' 순서
};

video.addEventListener("loadedmetadata", () => {
  const saved = store.get(posKey);
  const from = Number(params.get("t"));  // 내용 검색 결과에서 고른 시각
  if (from > 0) {
    video.currentTime = from;
    $("status").textContent = `찾은 낱말을 말한 ${fmt(from)}부터 봅니다.`;
  } else if (saved && saved.t > 5 && saved.t < video.duration - 5) {
    video.currentTime = saved.t;
    $("status").textContent = `지난번에 보던 ${fmt(saved.t)}부터 이어서 봅니다.`;
  }
}, { once: true });
video.addEventListener("pause", savePosition);
video.addEventListener("ended", savePosition);
video.addEventListener("timeupdate", () => {
  if (Math.abs(video.currentTime - lastSaved) >= 5) savePosition();
  showCurrent(video.currentTime);
});

function currentItem(items, t) {
  let found = null;
  for (const item of items) {
    if (item.start <= t + 0.25) found = item;
    else break;
  }
  return found;
}

let activeChapter = null, activePage = null, activeRef = null;
function showCurrent(t) {
  const page = currentItem(pages, t);
  if (page !== activePage) {
    activePage?.item.classList.remove("active");
    page?.item.classList.add("active");
    activePage = page;
  }
  const chapter = currentItem(chapters, t);
  if (chapter !== activeChapter) {
    activeChapter?.card.classList.remove("active");
    activeChapter?.bar.classList.remove("active");
    chapter?.card.classList.add("active");
    chapter?.bar.classList.add("active");
    $("now").textContent = chapter ? `지금: ${chapter.title}` : "";
    activeChapter = chapter;
  }
  // 학원 정리 항목은 시간을 찾을 때 본 3분 구간 동안만 강조합니다.
  const latest = currentItem(refItems, t);
  const ref = latest && t - latest.start <= 180 ? latest : null;
  if (ref !== activeRef) {
    activeRef?.item.classList.remove("active");
    ref?.item.classList.add("active");
    activeRef = ref;
  }
}
