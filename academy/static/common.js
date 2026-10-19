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
