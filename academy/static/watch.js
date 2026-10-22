const id = new URLSearchParams(location.search).get("id");
const $ = (elementId) => document.getElementById(elementId);
const video = $("video");
video.src = `/media/${id}`;

let chapters = [];  // { start, title, card, bar }
let pages = [];     // { start, item }

function seek(t) {
  video.currentTime = t;
  video.play().catch(() => {});
}

function timeButton(t) {
  return el("button", { class: "time", onclick: () => seek(t) }, fmt(t));
}

function notice(text) {
  return el("p", { class: "notice" }, text);
}

// ---- 탭 ----
for (const tab of document.querySelectorAll(".tabs button")) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll(".tabs button")) other.classList.toggle("active", other === tab);
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
  if (!analysis) {
    const msg = "아직 분석되지 않은 영상입니다. 선생님이 분석을 실행하면 요점 정리·페이지·퀴즈가 생깁니다.";
    for (const tab of ["guide", "pages", "quiz", "ask"]) $(`tab-${tab}`).replaceChildren(notice(msg));
    return;
  }
  renderPages(analysis.pages || []);
  setupAsk();
  if (analysis.guide) {
    renderGuide(analysis.guide, analysis.duration);
    renderQuiz(analysis.guide.quiz);
  } else if (references.length) {
    renderReferences(references);
    renderQuiz(references.flatMap((r) => r.quiz));
  } else {
    const msg = "이 강의는 아직 요점 정리가 없습니다. 페이지는 사용할 수 있습니다.";
    $("tab-guide").replaceChildren(notice(msg));
    $("tab-quiz").replaceChildren(notice(msg));
  }
}

// ---- 요점 정리 + 챕터 점프 ----
function renderGuide(guide, duration) {
  const box = $("tab-guide");
  box.replaceChildren(el("p", { class: "summary" }, guide.summary));
  if (guide.overview?.length || guide.glossary?.length) box.append(overviewCard(guide));
  const bar = $("chapter-bar");
  bar.hidden = guide.chapters.length === 0;
  chapters = guide.chapters.map((c, i) => {
    const card = el("article", { class: "chapter" },
      el("h3", {}, timeButton(c.start), " ", c.title),
      el("ul", {}, ...c.points.map((p) => el("li", {}, p))));
    box.append(card);
    const end = i + 1 < guide.chapters.length ? guide.chapters[i + 1].start : duration;
    const segment = el("button", {
      title: `${fmt(c.start)} ${c.title}`,
      "aria-label": `${fmt(c.start)} ${c.title}로 이동`,
      style: `flex-grow: ${Math.max(end - c.start, 1)}`,
      onclick: () => seek(c.start),
    });
    bar.append(segment);
    return { start: c.start, title: c.title, card, bar: segment };
  });
}

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
  $("tab-guide").replaceChildren(
    notice("학원 요점 정리입니다. 설명하는 장면은 페이지 탭에서 찾아 이동할 수 있습니다."),
    ...references.map(({ source, sections }) => el("article", { class: "overview reference" },
      el("h3", {}, source),
      ...sections.flatMap(({ name, items }) => [el("h4", {}, name), el("ul", {}, ...items.map((item) => el("li", {}, item)))]))));
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
function renderQuiz(quiz) {
  const box = $("tab-quiz");
  if (!quiz.length) { box.replaceChildren(notice("이 강의에는 퀴즈가 없습니다.")); return; }
  const choiceCount = quiz.filter((q) => q.choices).length;
  let answered = 0, correct = 0;
  const score = el("p", { class: "score" });
  const updateScore = () => { score.textContent = `${choiceCount}문제 중 ${answered}문제 풀이 · ${correct}개 정답`; };
  updateScore();
  score.hidden = choiceCount === 0;
  const cards = quiz.map((q, n) => {
    if (q.parts) return blankCard(q, n);
    const feedback = el("div", { class: "feedback", hidden: "" });
    const choices = q.choices.map((choice, i) => el("button", {
      class: "choice",
      onclick: () => {
        answered++;
        if (i === q.answer) correct++;
        updateScore();
        choices.forEach((b, k) => {
          b.disabled = true;
          if (k === q.answer) b.classList.add("right");
          else if (k === i) b.classList.add("wrong");
        });
        feedback.replaceChildren(
          el("strong", {}, i === q.answer ? "정답입니다! " : "아쉬워요. "), q.explanation,
          // 학원 정리로 만든 문제는 영상 시간이 없습니다.
          ...(q.time == null ? [] : [" ", el("button", { class: "link", onclick: () => seek(q.time) }, `▶ ${fmt(q.time)} 설명 다시 보기`)]));
        feedback.hidden = false;
      },
    }, `${i + 1}. ${choice}`));
    return el("article", { class: "question" }, el("h3", {}, `Q${n + 1}. ${q.question}`), ...choices, feedback);
  });
  box.replaceChildren(score, ...cards, el("button", { class: "retry", onclick: () => renderQuiz(quiz) }, "다시 풀기"));
}

// 학원 정리의 빈칸 문제: parts는 글과 빈칸이 번갈아 옵니다. 떠올려 본 뒤 답을 확인합니다.
function blankCard(q, n) {
  const line = el("p", { class: "blank-line" });
  const show = (open) => line.replaceChildren(...q.parts.flatMap((part, i) =>
    [i ? " " : "", i % 2 ? el("strong", { class: "blank" }, open ? part : "(          )") : part]));
  show(false);
  const reveal = el("button", { class: "choice", onclick: () => { show(true); reveal.hidden = true; } }, "답 보기");
  return el("article", { class: "question" }, el("h3", {}, `Q${n + 1}. 빈칸에 들어갈 말은?`),
    ...(q.context ? [el("blockquote", {}, q.context)] : []), line, reveal);
}

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

// ---- 이어보기 + 지금 위치 표시 ----
const posKey = `pos:${id}`;
let lastSaved = 0;
const savePosition = () => {
  lastSaved = video.currentTime;
  store.set(posKey, { t: video.currentTime, d: video.duration });
};

video.addEventListener("loadedmetadata", () => {
  const saved = store.get(posKey);
  if (saved && saved.t > 5 && saved.t < video.duration - 5) {
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

let activeChapter = null, activePage = null;
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
}
