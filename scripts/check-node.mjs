// Sprawdza wersję Node.js przed startem (aplikacja używa wbudowanego node:sqlite).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nWolne Korki potrzebują Node.js 22.13 lub nowszego, a masz ${process.versions.node}.`);
  console.error('W GitHub Codespaces wpisz:  nvm install 22 && nvm use 22   i uruchom ponownie.\n');
  process.exit(1);
}
