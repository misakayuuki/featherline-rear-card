const targets = [
  ['source', 'module/card'],
  ['compiled app assets', 'Featherline/app/src/main/assets/rearcard'],
];
const requested = process.env.FEATHERLINE_TEST_TARGET;
if (requested && requested !== 'source' && requested !== 'compiled') {
  throw new Error('FEATHERLINE_TEST_TARGET must be source or compiled');
}
module.exports = targets.filter(([name]) => !requested || (requested === 'source') === (name === 'source'));
