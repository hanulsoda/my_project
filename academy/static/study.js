// 요점노트·시험대비 그리기(watch.js가 /api/study/{id}를 받아 부릅니다).
// 글은 사람이 손으로 고친 JSON에서 올 수 있어서 innerHTML을 쓰지 않습니다: 요소는 createElement로 만들고,
// <b> <u> <br> 말고는 모두 글자 그대로 보입니다.

// text에서 <b>…</b>, <u>…</u>, <br>(속성 없음, 대소문자 무관)만 요소로 만들고 나머지는 글자로 넣습니다.
function inlineMarkup(text) {
  const out = document.createDocumentFragment();
  const open = [];  // 아직 닫지 않은 <b>·<u> 요소
  const add = (node) => (open.length ? open[open.length - 1].node : out).append(node);
  const addText = (s) => { if (s) add(document.createTextNode(s)); };
  const tag = /<(\/?)(b|u|br)\s*(\/?)>/gi, source = String(text ?? "");
  let last = 0, m;
  while ((m = tag.exec(source))) {
    addText(source.slice(last, m.index));
    last = tag.lastIndex;
    const [raw, closing, name, selfClosing] = m, lower = name.toLowerCase();
    if (lower === "br") {
      if (closing) addText(raw);  // </br>은 태그가 아니라 글자
      else add(document.createElement("br"));
    } else if (selfClosing) {
      addText(raw);  // <b/>도 글자
    } else if (!closing) {
      const node = document.createElement(lower);
      add(node);
      open.push({ tag: lower, node });
    } else {
      const at = open.map((o) => o.tag).lastIndexOf(lower);
      if (at < 0) addText(raw);  // 열지 않은 것을 닫음: 글자
      else open.length = at;
    }
  }
  addText(source.slice(last));
  return out;
}

const studyList = (value) => (Array.isArray(value) ? value : []);
const studyText = (tag, cls, text) => {
  const node = el(tag, cls ? { class: cls } : {});
  node.append(inlineMarkup(text));
  return node;
};

// 블록 하나를 그립니다. 알 수 없는 종류(t)는 null이라 건너뜁니다.
function studyBlock(block) {
  if (!block || typeof block !== "object") return null;
  switch (block.t) {
    case "big": {
      const box = el("section", { class: "study-big" }, studyText("h3", "", block.title));
      box.append(...studyBlocks(block.blocks));
      return box;
    }
    case "h": {
      const head = el("div", { class: "study-h" }, studyText("h4", "", block.title));
      if (block.sub) head.append(studyText("p", "study-sub", block.sub));
      return head;
    }
    case "def": return studyText("p", "study-def", block.text);
    case "tip": return studyText("p", "study-tip", block.text);
    case "card": {
      const card = el("div", { class: "study-card" });
      if (block.title) card.append(studyText("h4", "", block.title));
      card.append(el("ul", {}, ...studyList(block.items).map((item) => studyText("li", "", item))));
      return card;
    }
    case "list": return el("ul", { class: "study-list" }, ...studyList(block.items).map((item) => studyText("li", "", item)));
    case "flow": {
      const flow = el("div", { class: "study-flow" });
      if (block.title) flow.append(studyText("h4", "", block.title));
      flow.append(el("ol", {}, ...studyList(block.steps).map((step) =>
        el("li", {}, studyText("strong", "", step?.label), studyText("span", "", step?.text)))));
      return flow;
    }
    case "table": return studyTable(studyList(block.head), studyList(block.rows));
    default: return null;
  }
}

const studyBlocks = (blocks) => studyList(blocks).map(studyBlock).filter(Boolean);

function studyTable(head, rows) {
  const table = el("table", { class: "study-table" });
  if (head.length) table.append(el("thead", {}, el("tr", {}, ...head.map((h) => studyText("th", "", h)))));
  table.append(el("tbody", {}, ...rows.map((row) => el("tr", {}, ...studyList(row).map((cell) => studyText("td", "", cell))))));
  return el("div", { class: "study-table-wrap" }, table);
}

// 요점노트를 box에 그립니다. notes: {unit, sub, goals, blocks, words}
function renderNotes(box, notes) {
  notes = notes && typeof notes === "object" ? notes : {};
  const parts = [];
  if (notes.unit || notes.sub) {
    parts.push(el("header", { class: "study-title" }, studyText("h3", "", notes.unit), studyText("p", "study-sub", notes.sub)));
  }
  const goals = studyList(notes.goals);
  if (goals.length) {
    parts.push(el("div", { class: "study-card" }, el("h4", {}, "학습 목표"),
      el("ul", {}, ...goals.map((goal) => studyText("li", "", goal)))));
  }
  parts.push(...studyBlocks(notes.blocks));
  // 낱말: {w, def} 사전의 목록
  const words = studyList(notes.words).map((word) => [word?.w, word?.def]);
  if (words.length) {
    parts.push(el("section", { class: "study-big" }, el("h3", {}, "낱말"), studyTable(["낱말", "뜻"], words)));
  }
  box.replaceChildren(...parts);
}

// ---- 시험대비 ----
// 학생이 쓴 답을 비교하려고 고릅니다: NFC, 소문자, 공백과 문장부호 제거
function normalizeAnswer(text) {
  return String(text ?? "").normalize("NFC").toLowerCase().replace(/[\s.,·:;!?'"‘’“”()[\]~-]/g, "");
}

// 줄 단위로 나눠 <br>로 잇습니다(글은 inlineMarkup으로만 넣습니다)
function studyLines(text) {
  const out = document.createDocumentFragment();
  String(text ?? "").split("\n").forEach((line, i) => {
    if (i) out.append(document.createElement("br"));
    out.append(inlineMarkup(line));
  });
  return out;
}

const STUDY_TOTAL = 30;  // 점수에 들어가는 문제: 객관식·OX·단답형

// 시험대비 탭을 box에 그립니다. quiz: {passages, mc, sub, ox, short}. 점수는 "study:<studyId>"에만 저장합니다.
function renderStudyQuiz(box, quiz, studyId) {
  quiz = quiz && typeof quiz === "object" ? quiz : {};
  const results = new Map();  // 문제 번호 → 맞았는지
  const last = store.get("study:" + studyId);
  const score = el("p", { class: "study-score", "aria-live": "polite" });
  let number = 0;
  const lastText = last && Number.isFinite(last.right) ? ` · 지난번 ${last.right}/${STUDY_TOTAL}` : "";
  const showScore = () => {
    const right = [...results.values()].filter(Boolean).length;
    score.replaceChildren(`맞힌 문제 ${right}/${STUDY_TOTAL}${lastText}`);
    if (results.size >= STUDY_TOTAL) {  // 모두 풀었으면 저장(‘내 답도 맞아요’로 고치면 다시 저장)
      score.append(" · 모두 풀었습니다.");
      store.set("study:" + studyId, { right, total: STUDY_TOTAL, at: Date.now() });
    }
  };
  const record = (id, right) => { results.set(id, right); showScore(); };
  const section = (title, cards) => (cards.length ? [el("h3", { class: "study-section" }, title), ...cards] : []);
  const heading = (n, text) => { const h = el("h3", {}, `Q${n}. `); h.append(inlineMarkup(text)); return h; };

  const passages = studyList(quiz.passages).map((p) => {
    const body = el("details", { class: "study-passage", open: "" },
      el("summary", {}, `[${p?.label ?? ""}] `, inlineMarkup(p?.title)));
    for (const para of studyList(p?.paras)) body.append(studyText("p", "", para));
    if (p?.source) body.append(studyText("p", "study-sub", p.source));
    return body;
  });

  const choiceCard = (q, n, id) => {
    const [title, ...rest] = String(q.question).split("\n");
    const card = quizCard({ question: title, choices: q.choices, answer: q.answer, explanation: q.explanation },
      n, (right) => record(id, right), () => null, { review: false });
    if (rest.some((line) => line.trim())) card.querySelector("h3").after(el("blockquote", {}, studyLines(rest.join("\n"))));
    return card;
  };

  const mc = studyList(quiz.mc).map((q) => {
    const n = ++number;
    return choiceCard({ question: String(q?.q ?? ""), choices: studyList(q?.choices).map(String), answer: q?.answer, explanation: String(q?.exp ?? "") }, n, `q${n}`);
  });

  const sub = studyList(quiz.sub).map((q) => {
    const n = ++number;
    const model = el("div", { class: "study-model-box", hidden: "" });
    const reveal = el("button", { class: "choice", type: "button", onclick: () => {
      reveal.hidden = true;
      const done = el("div", { class: "study-judge" });
      const decide = (knew) => { done.replaceChildren(el("p", { class: "feedback" }, knew ? "좋아요!" : "모범 답안을 한 번 더 읽어 보세요.")); };
      done.append(el("button", { class: "choice", type: "button", onclick: () => decide(true) }, "알았어요"),
                  el("button", { class: "choice", type: "button", onclick: () => decide(false) }, "몰랐어요"));
      model.replaceChildren(studyText("p", "study-model", q?.model), ...(q?.note ? [studyText("p", "study-sub", q.note)] : []), done);
      model.hidden = false;
      model.scrollIntoView({ block: "nearest" });
    } }, "모범 답안 보기");
    return el("article", { class: "question" }, heading(n, q?.q),
      el("textarea", { rows: "3", "aria-label": `${n}번 내 답 쓰기(저장하지 않습니다)` }), reveal, model);
  });

  const ox = studyList(quiz.ox).map((q) => {
    const n = ++number;
    return choiceCard({ question: String(q?.q ?? ""), choices: ["O", "X"], answer: q?.answer ? 0 : 1, explanation: String(q?.exp ?? "") }, n, `q${n}`);
  });

  const short = studyList(quiz.short).map((q) => {
    const n = ++number, id = `q${n}`;
    const input = el("input", { type: "text", autocomplete: "off", "aria-label": `${n}번 답` });
    const button = el("button", { type: "submit" }, "확인");
    const feedback = el("div", { class: "feedback", hidden: "", "aria-live": "polite" });
    const accepted = [q?.answer, ...studyList(q?.alts)].map(normalizeAnswer).filter(Boolean);
    const explain = () => [studyText("span", "", q?.exp)];
    const form = el("form", { class: "study-short" }, input, button);
    form.onsubmit = (e) => {
      e.preventDefault();
      const typed = normalizeAnswer(input.value);
      if (!typed) {  // 빈 입력은 채점하지 않습니다
        feedback.replaceChildren("답을 써 주세요.");
        feedback.hidden = false;
        return;
      }
      input.disabled = button.disabled = true;
      feedback.hidden = false;
      if (accepted.includes(typed)) {
        feedback.replaceChildren(el("strong", {}, "정답입니다! "), ...explain());
        record(id, true);
      } else {
        const fix = el("button", { class: "choice", type: "button", onclick: () => {
          feedback.replaceChildren(el("strong", {}, "정답입니다! "), ...explain());
          record(id, true);
        } }, "내 답도 맞아요");
        feedback.replaceChildren(el("strong", {}, "아쉬워요. "), `정답: ${q?.answer ?? ""}. `, ...explain(), " ", fix);
        record(id, false);
      }
    };
    return el("article", { class: "question" }, heading(n, q?.q), form, feedback);
  });

  if (!number) { box.replaceChildren(el("p", { class: "notice" }, "시험 문제가 없습니다.")); return; }
  showScore();
  const again = el("button", { type: "button", onclick: () => { renderStudyQuiz(box, quiz, studyId); box.scrollIntoView({ block: "start" }); } }, "다시 풀기");
  box.replaceChildren(el("p", { class: "notice" }, "점수는 연습용이며 실제 평가가 아닙니다."), ...passages,
    ...section("객관식 (5지선다)", mc), ...section("주관식", sub), ...section("OX", ox), ...section("단답형", short),
    el("div", { class: "study-score-row" }, score, again));
}
