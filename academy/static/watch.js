const id = new URLSearchParams(location.search).get("id");
const $ = (elementId) => document.getElementById(elementId);
const video = $("video");
video.src = `/media/${id}`;
// 우클릭 메뉴의 "동영상을 다른 이름으로 저장"을 막습니다 (마음먹고 받는 것까지 막지는 못함).
video.addEventListener("contextmenu", (e) => e.preventDefault());
// 영상을 열어 둔 채 12시간이 지나면 재생이 401로 막히므로, 그때도 로그인 안내로 바꿉니다.
video.addEventListener("error", () => fetch(`/api/videos/${id}`).then(reloadIfLoggedOut));

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
  if (analysis.segments.length) {  // 받아쓴 대본으로 자막. 영상의 CC 버튼으로 켜고 끕니다.
    const track = el("track", { kind: "subtitles", srclang: "ko", label: "한국어 자막",
                                src: `/api/videos/${id}/subtitles.vtt` });
    video.append(track);
    // 한 번 켜면 다음 강의에서도 켜져 있게 기억합니다.
    if (store.get("cc")) track.track.mode = "showing";
    video.textTracks.addEventListener("change", () => store.set("cc", track.track.mode === "showing"));
  }
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
    if (Number.isInteger(c.board)) {  // 분석이 고른 판서 사진. 누르면 그 장면으로
      card.append(el("button", { class: "board", title: `${fmt(c.board)} 장면으로 이동`, onclick: () => seek(c.board) },
        el("img", { src: `/frames/${id}/${c.board}.jpg`, loading: "lazy", alt: `판서 ${fmt(c.board)}`,
                    onerror: (e) => e.target.parentElement.remove() })));  // 사진 파일이 없으면 깨진 칸 대신 숨김
    }
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
// 틀린 문제는 문제 글로 기억합니다. 다시 분석해 문제 순서가 바뀌어도 섞이지 않습니다.
const wrongKey = `wrong:${id}`;

function renderQuiz(quiz, only = null) {
  const box = $("tab-quiz");
  if (!quiz.length) { box.replaceChildren(notice("이 강의에는 퀴즈가 없습니다.")); return; }
  const savedWrong = () => (store.get(wrongKey) || []).filter((text) => quiz.some((q) => q.question === text));
  const shown = only ? quiz.filter((q) => only.includes(q.question)) : quiz;
  let answered = 0, correct = 0;
  const score = el("p", { class: "score" });
  const updateScore = () => { score.textContent = `${shown.length}문제 중 ${answered}문제 풀이 · ${correct}개 정답`; };
  updateScore();
  const retryWrong = el("button", { class: "retry retry-wrong", onclick: () => renderQuiz(quiz, savedWrong()) });
  const updateRetryWrong = () => {
    const n = savedWrong().length;
    retryWrong.hidden = n === 0;
    retryWrong.textContent = `틀린 문제만 다시 풀기 (${n}개)`;
  };
  updateRetryWrong();
  const cards = shown.map((q) => {
    const feedback = el("div", { class: "feedback", hidden: "" });
    const choices = q.choices.map((choice, i) => el("button", {
      class: "choice",
      onclick: () => {
        answered++;
        if (i === q.answer) correct++;
        updateScore();
        const wrong = new Set(savedWrong());
        if (i === q.answer) wrong.delete(q.question);
        else wrong.add(q.question);
        store.set(wrongKey, [...wrong]);
        updateRetryWrong();
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
    const number = quiz.indexOf(q) + 1;  // 틀린 문제만 풀 때도 원래 번호
    return el("article", { class: "question" }, el("h3", {}, `Q${number}. ${q.question}`), ...choices, feedback);
  });
  box.replaceChildren(score, ...cards,
    el("div", { class: "quiz-actions" },
      el("button", { class: "retry", onclick: () => renderQuiz(quiz) }, only ? "전체 문제 풀기" : "다시 풀기"),
      retryWrong));
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

// ---- 재생 속도 + 단축키 ----
const RATES = [0.75, 1, 1.25, 1.5, 2];
$("speed").append(...RATES.map((rate) => el("button", { "data-rate": rate, onclick: () => setRate(rate) }, `${rate}배`)));

function setRate(rate) {
  video.defaultPlaybackRate = rate;  // 영상을 다시 불러와도 유지됩니다.
  video.playbackRate = rate;
  showRate();  // ratechange는 조금 늦게 오므로 바로 표시합니다.
}

function showRate() {
  for (const b of $("speed").children) {
    const on = Number(b.dataset.rate) === video.playbackRate;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);  // 화면 낭독기에도 지금 속도를 알립니다
  }
}

// 영상 자체 메뉴에서 속도를 바꿔도 버튼 표시와 저장이 따라갑니다. 다음 강의도 같은 속도로 봅니다.
video.addEventListener("ratechange", () => { store.set("rate", video.playbackRate); showRate(); });
// 영상 자체 메뉴에서 고른 속도(1.75배 등)도 이어서 씁니다.
const savedRate = store.get("rate");
setRate(typeof savedRate === "number" && savedRate >= 0.25 && savedRate <= 4 ? savedRate : 1);

// 질문·메모·검색 칸에 글을 쓰는 중에는 단축키를 쓰지 않습니다.
// Shift+스페이스(페이지 위로) 같은 조합키도 단축키로 보지 않습니다.
const typing = (e) => e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing
  || e.target.closest("input, textarea, select");
// 키보드(Tab)로 버튼에 간 학생은 스페이스로 그 버튼을 누릅니다 (퀴즈 보기 고르기 등).
const onControl = (e) => e.key === " " && e.target.closest("button, a");

// 마우스로 누른 버튼에는 초점이 남지 않게 해서, 누른 뒤의 스페이스는 영상 재생·멈춤이 되게 합니다.
document.addEventListener("mousedown", (e) => { if (e.target.closest("button, a")) e.preventDefault(); });

// 영상에 초점이 있으면 브라우저도 같은 키로 재생·멈춤·이동을 한 번 더 하므로,
// 영상보다 먼저 받는 단계(capture)에서 처리하고 브라우저 동작은 막습니다.
document.addEventListener("keyup", (e) => { if (e.key === " " && !typing(e) && !onControl(e)) e.preventDefault(); }, true);

document.addEventListener("keydown", (e) => {
  if (typing(e) || onControl(e)) return;
  if (e.key === " ") {
    if (e.repeat) { /* 꾹 누르고 있을 때 재생·멈춤이 반복되지 않게 */ }
    else if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (e.key === "ArrowLeft") video.currentTime -= 10;
  else if (e.key === "ArrowRight") video.currentTime += 10;
  else return;
  e.preventDefault();  // 페이지 스크롤과 영상 자체 단축키가 한 번 더 움직이지 않게
}, true);
