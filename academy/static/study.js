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
  // 낱말: [낱말, 뜻] 쌍(사전 {w, def}도 받습니다)
  const words = studyList(notes.words).map((word) => (Array.isArray(word) ? word : [word?.w, word?.def]));
  if (words.length) {
    parts.push(el("section", { class: "study-big" }, el("h3", {}, "낱말"), studyTable(["낱말", "뜻"], words)));
  }
  box.replaceChildren(...parts);
}
