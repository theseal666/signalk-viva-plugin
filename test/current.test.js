const assert = require('chai').assert;
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../index.js'), 'utf8');

// The plugin is one closure over the SignalK app object with no exported
// internals, so these exercise the pure helpers by lifting them out of the
// source. Narrow, but they pin the behaviour that actually broke things:
// per-depth paths, knots conversion, and not feeding the wind alarms.
function lift(name) {
  const i = src.indexOf(`function ${name} (`);
  assert.isAbove(i, -1, `${name} not found`);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) { j = k + 1; break; }
  }
  return src.slice(i, j);
}
const CURRENT_DEPTH = /^str[öo]m\s*(yta|\d+\s*m)\b/i;
const currentDepth = eval(`(${lift('currentDepth').replace('function currentDepth', 'function')})`);
const toSI = eval(`(${lift('toSI').replace('function toSI', 'function')})`);

describe('viva current logging', () => {
  it('maps every depth ViVa reports to its own slug', () => {
    assert.equal(currentDepth('Ström Yta'), 'surface');
    assert.equal(currentDepth('Ström 3m'), '3m');
    assert.equal(currentDepth('Ström 7m'), '7m');
    assert.equal(currentDepth('Ström 11m'), '11m');
    assert.equal(currentDepth('Ström 15m'), '15m');
  });

  it('gives each depth a distinct path, so push() cannot drop four of five', () => {
    const names = ['Ström Yta','Ström 3m','Ström 7m','Ström 11m','Ström 15m'];
    const paths = names.map(n => `water.current.${currentDepth(n)}.drift`);
    assert.equal(new Set(paths).size, 5, 'paths must be unique per depth');
  });

  it('ignores things that merely start with strom-ish text', () => {
    assert.isNull(currentDepth('Strömstad'));
    assert.isNull(currentDepth('Lufttemp'));
    assert.isNull(currentDepth('Vattentemp 3m'));
  });

  it('tolerates the o-spelling and odd spacing', () => {
    assert.equal(currentDepth('Strom 3 m'), '3m');
    assert.equal(currentDepth('STRÖM YTA'), 'surface');
  });

  it('converts knots to m/s', () => {
    assert.closeTo(toSI(1, 'knop'), 0.5144444, 1e-6);
    assert.closeTo(toSI(1.3, 'knop'), 0.6688, 1e-3);   // Torshamnen surface, 18 Oct
    assert.closeTo(toSI(1.6, 'kn'), 0.8231, 1e-3);     // Karet surface
  });

  it('still converts the units it always did', () => {
    assert.equal(toSI(5, 'm/s'), 5);
    assert.equal(toSI(1013, 'hPa'), 101300);
    assert.closeTo(toSI(10, '°C'), 283.15, 1e-9);
    assert.equal(toSI(50, 'cm'), 0.5);
  });

  it('keeps the current set out of the wind-shift history', () => {
    // A 1.3 kn stream setting 220 deg must not look like a wind veer to the
    // alarm logic, which is why recordHistory is gated on the wind path.
    const i = src.indexOf('const dirPath = kind.dirFor');
    assert.isAbove(i, -1, 'dirPath resolution must exist');
    const block = src.slice(i, i + 600);
    assert.include(block, 'if (dirPath === DIRECTION_SUFFIX) recordHistory',
      'windDir history must be gated on the wind direction path');
  });

  it('does not make current a qualifying sample', () => {
    // Stations are selected on wind; adding current must not change which
    // stations get followed.
    const i = src.indexOf('match: CURRENT_DEPTH');
    const block = src.slice(i, src.indexOf(']', i));
    assert.notInclude(block, 'qualifies');
  });
});
