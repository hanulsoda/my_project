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

// 검색어(q, 소문자)가 나오는 곳을 형광펜(<mark>)으로 표시합니다.
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

// ---- 퀴즈 (강의 화면의 퀴즈 탭과 틀린 문제 복습 화면이 함께 씁니다) ----
// 4지선다 문제 하나. 답을 고르면 정답을 표시하고 onAnswer(맞았는지)를 부릅니다. replay는 해설 뒤 "설명 다시 보기".
function quizCard(q, number, onAnswer, replay) {
  const feedback = el("div", { class: "feedback", hidden: "" });
  const choices = q.choices.map((choice, i) => el("button", {
    class: "choice",
    onclick: () => {
      onAnswer(i === q.answer);
      choices.forEach((b, k) => {
        b.disabled = true;
        if (k === q.answer) b.classList.add("right");
        else if (k === i) b.classList.add("wrong");
      });
      feedback.replaceChildren(el("strong", {}, i === q.answer ? "정답입니다! " : "아쉬워요. "), q.explanation, " ", replay);
      feedback.hidden = false;
    },
  }, `${i + 1}. ${choice}`));
  return el("article", { class: "question" }, el("h3", {}, `Q${number}. ${q.question}`), ...choices, feedback);
}

// "설명 다시 보기"로 갈 시각이 있는 문제인지. 손으로 고치다 "1:40"처럼 글자가 되거나 빠질 수 있습니다.
function hasTime(q) {
  return typeof q.time === "number" && Number.isFinite(q.time) && q.time >= 0;
}

// 틀린 문제는 강의마다 문제 글로 기억합니다(wrong:<강의 id>). 다시 분석해 순서가 바뀌어도 섞이지 않습니다.
function markWrong(videoId, question, wrong) {
  const set = new Set(store.get(`wrong:${videoId}`) || []);
  if (wrong) set.add(question);
  else set.delete(question);
  store.set(`wrong:${videoId}`, [...set]);
}

// 틀린 문제가 남아 있는 강의들: [{ id, questions }]
function wrongLists() {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith("wrong:"))
      .map((key) => ({ id: key.slice("wrong:".length), questions: store.get(key) }))
      .filter((w) => Array.isArray(w.questions) && w.questions.length);
  } catch {
    return [];  // 브라우저가 저장소를 막아 둔 경우
  }
}

// 들어온 지 12시간이 지나 401을 받으면 새로 고쳐서 로그인 안내 화면을 보여 줍니다.
function reloadIfLoggedOut(res) {
  if (res.status !== 401) return res;
  location.reload();
  return new Promise(() => {});  // 새로 고치는 동안 뒤이은 처리를 멈춥니다.
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
