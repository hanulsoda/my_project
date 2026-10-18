const id = new URLSearchParams(location.search).get("id");
const $ = (elementId) => document.getElementById(elementId);
const video = $("video");
video.src = `/media/${id}`;

let chapters = [];  // { start, title, card, bar }
let lines = [];     // { start, text, li }

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
  .then(reloadIfLoggedOut)
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(render)
  .catch(() => { $("title").textContent = "영상을 찾을 수 없습니다"; });

function render({ title, analysis }) {
  document.title = title;
  $("title").textContent = title;
  if (!analysis) {
    const msg = "아직 분석되지 않은 영상입니다. 선생님이 분석을 실행하면 요점 정리·대본·퀴즈가 생깁니다.";
    for (const tab of ["guide", "transcript", "quiz", "ask"]) $(`tab-${tab}`).replaceChildren(notice(msg));
    return;
  }
  renderTranscript(analysis.segments);
  setupAsk();
  if (analysis.guide) {
    renderGuide(analysis.guide, analysis.duration);
    renderQuiz(analysis.guide.quiz);
  } else {
    const msg = "요점 정리를 아직 만들지 못했습니다. 대본과 질문하기는 사용할 수 있습니다.";
    $("tab-guide").replaceChildren(notice(msg));
    $("tab-quiz").replaceChildren(notice(msg));
  }
}

// ---- 요점 정리 + 챕터 점프 ----
function renderGuide(guide, duration) {
  const box = $("tab-guide");
  box.replaceChildren(el("p", { class: "summary" }, guide.summary));
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

// ---- 대본 + 검색 ----
function renderTranscript(segments) {
  lines = segments.map((s) => {
    const text = el("span", { class: "text" }, s.text);
    const li = el("li", {}, el("button", { class: "line", onclick: () => seek(s.start) },
      el("span", { class: "time" }, fmt(s.start)), text));
    $("lines").append(li);
    return { start: s.start, text: s.text, li };
  });
  $("search").oninput = () => {
    const q = $("search").value.trim().toLowerCase();
    let hits = 0;
    for (const line of lines) {
      const hit = !q || line.text.toLowerCase().includes(q);
      line.li.hidden = !hit;
      if (hit && q) hits++;
      line.li.querySelector(".text").replaceChildren(...highlight(line.text, q));
    }
    $("search-count").textContent = q ? `${hits}곳` : "";
  };
}

function highlight(text, q) {
  if (!q) return [text];
  const parts = [], lower = text.toLowerCase();
  let from = 0, at;
  while ((at = lower.indexOf(q, from)) !== -1) {
    parts.push(text.slice(from, at), el("mark", {}, text.slice(at, at + q.length)));
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return parts;
}

// ---- 복습 퀴즈 ----
function renderQuiz(quiz) {
  const box = $("tab-quiz");
  if (!quiz.length) { box.replaceChildren(notice("이 강의에는 퀴즈가 없습니다.")); return; }
  let answered = 0, correct = 0;
  const score = el("p", { class: "score" });
  const updateScore = () => { score.textContent = `${quiz.length}문제 중 ${answered}문제 풀이 · ${correct}개 정답`; };
  updateScore();
  const cards = quiz.map((q, n) => {
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
          el("strong", {}, i === q.answer ? "정답입니다! " : "아쉬워요. "), q.explanation, " ",
          el("button", { class: "link", onclick: () => seek(q.time) }, `▶ ${fmt(q.time)} 설명 다시 보기`));
        feedback.hidden = false;
      },
    }, `${i + 1}. ${choice}`));
    return el("article", { class: "question" }, el("h3", {}, `Q${n + 1}. ${q.question}`), ...choices, feedback);
  });
  box.replaceChildren(score, ...cards, el("button", { class: "retry", onclick: () => renderQuiz(quiz) }, "다시 풀기"));
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
  let busy = false;  // 답을 기다리는 동안 Enter로 같은 질문이 또 전송되지 않게 막습니다.
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = question.value.trim();
    if (!text || busy) return;
    busy = true;
    const button = form.querySelector("button");
    button.disabled = true;
    question.value = "";
    say("user", text);
    const reply = say("assistant", "답변을 만드는 중…");
    try {
      const res = await reloadIfLoggedOut(await fetch(`/api/videos/${id}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: text,
          history: history.slice(-20),
          current_time: $("use-time").checked ? video.currentTime : null,
        }),
      }));
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : `서버 오류 (${res.status})`);
      reply.replaceChildren(...linkify(body.answer));
      history.push({ role: "user", content: text }, { role: "assistant", content: body.answer });
    } catch (err) {
      reply.textContent = `답변을 받지 못했습니다. ${err.message}`;
      reply.classList.add("error");
      if (!question.value) question.value = text;  // 다시 보낼 수 있게 질문을 되돌려 놓습니다.
    } finally {
      busy = false;
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

// 학생이 대본을 직접 스크롤하는 동안에는 자동 스크롤을 잠시 멈춥니다.
let userScrolledAt = 0;
for (const evt of ["wheel", "touchmove"]) {
  $("tab-transcript").addEventListener(evt, () => { userScrolledAt = Date.now(); }, { passive: true });
}

function currentItem(items, t) {
  let found = null;
  for (const item of items) {
    if (item.start <= t + 0.25) found = item;
    else break;
  }
  return found;
}

let activeChapter = null, activeLine = null;
function showCurrent(t) {
  const chapter = currentItem(chapters, t);
  if (chapter !== activeChapter) {
    activeChapter?.card.classList.remove("active");
    activeChapter?.bar.classList.remove("active");
    chapter?.card.classList.add("active");
    chapter?.bar.classList.add("active");
    $("now").textContent = chapter ? `지금: ${chapter.title}` : "";
    activeChapter = chapter;
  }
  const line = currentItem(lines, t);
  if (line !== activeLine) {
    activeLine?.li.classList.remove("active");
    line?.li.classList.add("active");
    activeLine = line;
    const box = $("tab-transcript");
    if (line && !box.hidden && !$("search").value && Date.now() - userScrolledAt > 4000) {
      box.scrollTop = line.li.offsetTop - box.clientHeight / 3;
    }
  }
}
