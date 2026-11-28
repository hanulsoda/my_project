'use strict';
// public/js/geometry.js: sticky screen-geometry guard for a measurement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { geometryOf, geometryChanged, watchGeometry } = require('../public/js/geometry.js');

function fakeWindow(w, h) {
  const listeners = new Map();
  const target = () => ({
    addEventListener(ev, fn) { listeners.set(`${this.name}:${ev}`, fn); },
    removeEventListener(ev) { listeners.delete(`${this.name}:${ev}`); },
  });
  const win = { ...target(), name: 'win', innerWidth: w, innerHeight: h };
  win.visualViewport = { ...target(), name: 'vv', width: w, height: h, offsetLeft: 0, offsetTop: 0, scale: 1 };
  const fire = (key) => { const fn = listeners.get(key); if (fn) fn(); };
  const resize = (nw, nh) => {
    win.innerWidth = nw; win.innerHeight = nh; win.visualViewport.width = nw; win.visualViewport.height = nh;
    fire('win:resize'); fire('vv:resize');
  };
  return { win, fire, resize, listeners };
}

test('geometryChanged: 2 px and 1% scale tolerance', () => {
  const a = { w: 1280, h: 720, vw: 1280, vh: 720, vx: 0, vy: 0, scale: 1 };
  assert.equal(geometryChanged(a, { ...a }), false);
  assert.equal(geometryChanged(a, { ...a, h: 722 }), false);
  assert.equal(geometryChanged(a, { ...a, h: 717 }), true);
  assert.equal(geometryChanged(a, { ...a, vy: 30 }), true, 'visual viewport scrolled (e.g. keyboard)');
  assert.equal(geometryChanged(a, { ...a, scale: 1.005 }), false);
  assert.equal(geometryChanged(a, { ...a, scale: 1.2 }), true, 'pinch zoom');
  assert.equal(geometryChanged(a, { ...a, w: NaN }), true);
  assert.equal(geometryChanged(null, a), true);
});

test('watchGeometry: a resize that is undone stays flagged (sticky)', () => {
  const { win, resize } = fakeWindow(1280, 720);
  const g = watchGeometry(win);
  assert.equal(g.changed(), false);
  resize(1280, 600);
  resize(1280, 720);
  assert.deepEqual(geometryOf(win), g.base, 'back to the original size');
  assert.equal(g.changed(), true);
});

test('watchGeometry: zoom, rotation and a change without any event are caught; stop removes listeners', () => {
  const zoom = fakeWindow(1024, 768);
  const gz = watchGeometry(zoom.win);
  zoom.win.visualViewport.scale = 1.5; zoom.fire('vv:resize');
  zoom.win.visualViewport.scale = 1; zoom.fire('vv:resize');
  assert.equal(gz.changed(), true);

  const rot = fakeWindow(768, 1024);
  const gr = watchGeometry(rot.win);
  rot.win.innerWidth = 1024; rot.win.innerHeight = 768;
  rot.fire('win:orientationchange');
  assert.equal(gr.changed(), true);

  const silent = fakeWindow(1280, 720);
  const gs = watchGeometry(silent.win);
  silent.win.innerHeight = 650; // no event delivered
  assert.equal(gs.changed(), true, 'changed() also compares the current geometry');

  const quiet = fakeWindow(1280, 720);
  const gq = watchGeometry(quiet.win);
  assert.ok(quiet.listeners.size >= 4);
  gq.stop();
  assert.equal(quiet.listeners.size, 0);
});

test('geometryOf works without visualViewport', () => {
  assert.deepEqual(geometryOf({ innerWidth: 800, innerHeight: 600 }), { w: 800, h: 600, vw: 800, vh: 600, vx: 0, vy: 0, scale: 1 });
});
