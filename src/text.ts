import {outdent} from 'outdent';

/**
 * Multi-line string helpers. Every string in this project that spans more than one source line goes
 * through one of these, so indentation is never accidentally part of the value.
 */

/**
 * Writes a long single-line message as wrapped source.
 *
 * The messages here are read by a model deciding what to change and retry, so they are long on
 * purpose — but a 300-character string literal is unreadable in an editor and unreviewable in a
 * diff. `newline: ' '` folds the wrapped lines back into one line at runtime, so the caller sees
 * one sentence and the source stays inside the print width.
 */
export const sentence = outdent({newline: ' '});

/**
 * Keeps the newlines, drops the indentation. For a message whose line breaks are part of what it
 * says — a list, or a heading with items under it — rather than an artifact of wrapping.
 */
export {outdent as lines};
