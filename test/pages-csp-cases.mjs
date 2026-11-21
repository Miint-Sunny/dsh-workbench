/** Expected HTML5 prolog boundaries; only the first BOM is a decoding marker. */
export const cspPrologCases = [
  ...[['NBSP', '\u00a0'], ['vertical tab', '\u000b'], ['ideographic space', '\u3000'], ['line separator', '\u2028']].map(([name, text]) => [name, '', text, 'quirks']),
  ['two BOMs', '\uFEFF', '\uFEFF', 'quirks'],
  ['NBSP after doctype', '<!doctype html>', '\u00a0', 'no-quirks'],
  ['single BOM and ASCII whitespace', '\uFEFF\t\n\f\r <!doctype html>\n', '', 'no-quirks'],
  ['comment banner', '<!-- banner -->\n<!DOCTYPE html>\n', '', 'no-quirks'],
  ['short comments before doctype', '<!--><!---><!-- --!><!doctype html>', '', 'no-quirks'],
  ['comment after doctype', '<!doctype html><!-- banner -->\t', '', 'no-quirks'],
  ['legacy strict doctype', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">', '', 'no-quirks'],
  ['legacy transitional doctype', '<!-- banner --><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">', '', 'limited-quirks'],
  ['unclosed comment', '', '<!-- unclosed', 'quirks'],
  ['active content after a short comment', '<!--a--><!-->', '', 'quirks'],
]
