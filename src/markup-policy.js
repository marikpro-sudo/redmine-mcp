import { AccessError } from './config.js';

// redmine.medservice.kz uses the Markdown text formatter. Textile markup renders broken there
// (e.g. "# item" becomes a huge H1 heading, "h3." is printed literally).
export const markupPolicy = 'Формат текста: redmine.medservice.kz использует Markdown: заголовки `##`/`###`, списки `-` и `1.`, `**жирный**`, таблицы `| a | b |` со строкой `|---|`. Textile (`h2.`, `# пункт` как список, `|_.`) не использовать.';

const textileHeading = /^ {0,3}h[1-6]\.[ \t]/;
const textileHeaderCell = /\|_\./;
const fence = /^ {0,3}(```|~~~)/;

// Returns the first unambiguous Textile construct outside fenced code blocks, or null.
// Markdown headings ("# ", "## ") are valid and never reported.
export function findTextile(text) {
  if (typeof text !== 'string') return null;
  let inFence = false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (textileHeading.test(line)) return { line: i + 1, kind: 'heading', hint: 'заголовок `h2. Текст` замените на `## Текст` (`h3.` → `###`)' };
    if (textileHeaderCell.test(line)) return { line: i + 1, kind: 'table', hint: 'ячейки `|_. Заголовок |` замените на `| Заголовок |`, а под строкой заголовков добавьте `|---|---|`' };
  }
  return null;
}

// fields: { fieldName: text | undefined } or [[fieldName, text], ...]. Throws before any draft is stored.
export function assertMarkdown(fields) {
  for (const [field, value] of Array.isArray(fields) ? fields : Object.entries(fields)) {
    const found = findTextile(value);
    if (found) {
      throw new AccessError('TEXTILE_MARKUP', `Поле ${field}, строка ${found.line}: найдена разметка Textile. Redmine использует Markdown — ${found.hint}. Нумерованные списки пишите \`1.\`, маркированные \`-\`, жирный \`**текст**\`. Черновик не создан; перепишите текст в Markdown и подготовьте заново.`);
    }
  }
}
