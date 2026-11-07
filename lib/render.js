/**
 * Model-facing rendering for the `dsh-project-automemory` bundle.
 *
 * Turns the loaded memory snapshot into one `<system-reminder>` text block
 * within an explicit UTF-8 byte budget. This module is pure: it performs no
 * filesystem or crypto work, so budget behavior can be unit tested directly.
 * File contents are escaped so user-authored memory text can never close the
 * plugin-owned system reminder early.
 *
 * @module dsh-project-automemory/render
 */

/** Opening tag of the plugin-owned system reminder. */
export const SYSTEM_REMINDER_OPEN = '<system-reminder>';

/** Closing tag of the plugin-owned system reminder. */
export const SYSTEM_REMINDER_CLOSE = '</system-reminder>';

/** Literal the escaped form of {@link SYSTEM_REMINDER_CLOSE}. */
const ESCAPED_SYSTEM_REMINDER_CLOSE = '<\\/system-reminder>';

/** Prose used when the project has no memory files yet. */
const EMPTY_MEMORY_PROSE = (indexFile) =>
	`This project has no project memory yet. This directory is private to the project: it lives outside the project directory and is not shared with other projects or with other agents working in the project directory. Use the \`memory\` tool to record durable project knowledge (decisions, conventions, user preferences, commands, recurring pitfalls) so later conversations in this project start with it. Keep ${indexFile} as a short index and put details in topic files.`;

/** Intro used on an ordinary load of the project memory snapshot. */
const NORMAL_FILES_INTRO = (indexFile) =>
	`The following project memory files were loaded from this project's private memory directory. Treat them as durable knowledge from earlier conversations in this project; update them with the \`memory\` tool when they are outdated or when you learn something worth keeping. Keep ${indexFile} as the index.`;

/** Intro used when the loaded snapshot replaced an earlier baseline. */
const CHANGED_FILES_INTRO = (indexFile) =>
	`The project memory files below replaced the previously loaded project memory for this project. Treat them as durable knowledge from earlier conversations in this project; update them with the \`memory\` tool when they are outdated or when you learn something worth keeping. Keep ${indexFile} as the index.`;

/**
 * Measure the UTF-8 byte length of a string.
 * @param value - text to measure.
 * @returns number of UTF-8 bytes.
 */
function byteLength(value) {
	return Buffer.byteLength(value, 'utf8');
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character.
 * @param value - source text.
 * @param maxBytes - byte budget.
 * @returns the longest character-boundary prefix that fits.
 */
function truncateUtf8(value, maxBytes) {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.length <= maxBytes) return value;
	let end = Math.max(0, Math.trunc(maxBytes));
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end).toString('utf8');
}

/**
 * Escape any literal closing system-reminder tag in user-controlled text.
 * @param text - memory file name or content.
 * @returns text where `</system-reminder>` cannot terminate the frame.
 */
export function escapeSystemReminder(text) {
	if (typeof text !== 'string') throw new TypeError('escapeSystemReminder: text must be a string');
	return text.replaceAll(SYSTEM_REMINDER_CLOSE, ESCAPED_SYSTEM_REMINDER_CLOSE);
}

/**
 * Build the truncation marker appended inside a truncated file section.
 * @param maxBytes - active context byte budget.
 * @returns marker text beginning with a blank line.
 */
function truncationMarker(maxBytes) {
	return `\n\n[project memory truncated to fit the ${maxBytes}-byte context budget]`;
}

/**
 * Build the diagnostic line that reports omitted and truncated files.
 * @param options - budget outcome.
 * @param options.maxBytes - active context byte budget.
 * @param options.omittedFiles - names of files dropped entirely.
 * @param options.truncatedFiles - names of files rendered truncated.
 * @returns diagnostic line, or undefined when nothing was omitted or truncated.
 */
function budgetDiagnostic({ maxBytes, omittedFiles, truncatedFiles }) {
	const parts = [];
	if (omittedFiles.length > 0) parts.push(`omitted ${omittedFiles.join(', ')}`);
	if (truncatedFiles.length > 0) parts.push(`truncated ${truncatedFiles.join(', ')}`);
	if (parts.length === 0) return undefined;
	return `Project memory context budget ${maxBytes} bytes: ${parts.join('; ')}`;
}

/**
 * Build the empty-state system reminder.
 * @param options - render inputs.
 * @param options.displayPath - symbolic memory directory spelling.
 * @param options.indexFile - index file name.
 * @returns complete system-reminder text.
 */
function buildEmptyFrame({ displayPath, indexFile }) {
	return (
		`${SYSTEM_REMINDER_OPEN}\n` +
		`Project memory directory: ${displayPath}\n\n` +
		`${EMPTY_MEMORY_PROSE(indexFile)}\n` +
		SYSTEM_REMINDER_CLOSE
	);
}

/**
 * Build the full system reminder for a set of rendered files.
 * @param options - frame inputs.
 * @param options.displayPath - symbolic memory directory spelling.
 * @param options.indexFile - index file name.
 * @param options.changed - whether this snapshot replaced a prior baseline.
 * @param options.renderedFiles - ordered `{ name, content }` entries to render.
 * @param options.diagnostic - optional budget diagnostic line.
 * @returns complete system-reminder text.
 */
function buildFrame({ displayPath, indexFile, changed, renderedFiles, diagnostic }) {
	const intro = changed ? CHANGED_FILES_INTRO(indexFile) : NORMAL_FILES_INTRO(indexFile);
	let text = `${SYSTEM_REMINDER_OPEN}\n`;
	if (diagnostic !== undefined) text += `${diagnostic}\n`;
	text += `Project memory directory: ${displayPath}\n\n${intro}`;
	for (const file of renderedFiles) {
		text += `\n\n## ${escapeSystemReminder(file.name)}\n\n${escapeSystemReminder(file.content)}`;
	}
	return `${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * Normalize snapshot entries for rendering.
 * @param files - caller-supplied snapshot entries.
 * @returns ordered `{ name, content }` entries with string fields.
 */
function normalizeFiles(files) {
	if (!Array.isArray(files)) return [];
	const normalized = [];
	for (const file of files) {
		if (file === null || typeof file !== 'object') continue;
		const name = typeof file.name === 'string' ? file.name : String(file.name ?? '');
		const content = typeof file.content === 'string' ? file.content : '';
		normalized.push({ name, content });
	}
	return normalized;
}

/**
 * Render the project memory context block for the system prompt.
 *
 * Budget policy, in order: include everything when it fits; otherwise drop
 * whole files from the end (keeping the index/first files); when the first
 * file alone still does not fit, truncate its content on a UTF-8 boundary and
 * append a marker; when even the heading frame does not fit, return the
 * best-fitting UTF-8-safe truncated frame. The returned text never exceeds
 * `maxBytes` UTF-8 bytes, and an empty string is returned only when the budget
 * is zero or negative (a disabled reminder).
 * @param options - render inputs.
 * @param options.files - ordered snapshot entries, index file first.
 * @param options.displayPath - symbolic memory directory spelling.
 * @param options.indexFile - index file name.
 * @param options.maxBytes - UTF-8 byte budget.
 * @param options.changed - whether this snapshot replaced a prior baseline.
 * @returns `{ text, includedFiles, omittedFiles, truncatedFiles }`.
 */
export function renderMemoryContext({
	files,
	displayPath,
	indexFile = 'MEMORY.md',
	maxBytes = 16384,
	changed = false,
} = {}) {
	const disabledResult = { text: '', includedFiles: [], omittedFiles: [], truncatedFiles: [] };
	if (!(maxBytes > 0)) return disabledResult;
	// At least one byte is needed for the opening "<" of the frame.
	const budget = Math.max(1, Math.trunc(maxBytes));
	const display = typeof displayPath === 'string' ? displayPath : '';
	const index = typeof indexFile === 'string' && indexFile.length > 0 ? indexFile : 'MEMORY.md';
	const entries = normalizeFiles(files);
	if (entries.length === 0) {
		const frame = buildEmptyFrame({ displayPath: display, indexFile: index });
		const text = byteLength(frame) <= budget ? frame : truncateUtf8(frame, budget);
		return { text, includedFiles: [], omittedFiles: [], truncatedFiles: [] };
	}
	const allNames = entries.map((entry) => entry.name);
	const fullText = buildFrame({ displayPath: display, indexFile: index, changed, renderedFiles: entries });
	if (byteLength(fullText) <= budget) {
		return { text: fullText, includedFiles: allNames.slice(), omittedFiles: [], truncatedFiles: [] };
	}
	// Drop whole files from the end, keeping the index/first file for truncation.
	for (let count = entries.length - 1; count >= 1; count -= 1) {
		const omittedFiles = allNames.slice(count);
		const diagnostic = budgetDiagnostic({ maxBytes: budget, omittedFiles, truncatedFiles: [] });
		const text = buildFrame({
			displayPath: display,
			indexFile: index,
			changed,
			renderedFiles: entries.slice(0, count),
			diagnostic,
		});
		if (byteLength(text) <= budget) {
			return { text, includedFiles: allNames.slice(0, count), omittedFiles, truncatedFiles: [] };
		}
	}
	// A single remaining file does not fit: truncate its content.
	const firstName = entries[0].name;
	const firstContent = entries[0].content;
	const omittedAfterFirst = allNames.slice(1);
	const attemptTruncated = (cutoffBytes) => {
		const content = `${truncateUtf8(firstContent, cutoffBytes)}${truncationMarker(budget)}`;
		const diagnostic = budgetDiagnostic({
			maxBytes: budget,
			omittedFiles: omittedAfterFirst,
			truncatedFiles: [firstName],
		});
		return buildFrame({
			displayPath: display,
			indexFile: index,
			changed,
			renderedFiles: [{ name: firstName, content }],
			diagnostic,
		});
	};
	const minimalAttempt = attemptTruncated(0);
	if (byteLength(minimalAttempt) <= budget) {
		let low = 0;
		let high = byteLength(firstContent);
		let best = minimalAttempt;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const candidate = attemptTruncated(middle);
			if (byteLength(candidate) <= budget) {
				low = middle;
				best = candidate;
			} else {
				high = middle - 1;
			}
		}
		return {
			text: best,
			includedFiles: [firstName],
			omittedFiles: omittedAfterFirst,
			truncatedFiles: [firstName],
		};
	}
	// Even the heading frame with the marker does not fit: truncate the frame.
	const headingText = buildFrame({
		displayPath: display,
		indexFile: index,
		changed,
		renderedFiles: [],
		diagnostic: budgetDiagnostic({ maxBytes: budget, omittedFiles: allNames, truncatedFiles: [] }),
	});
	const text = byteLength(headingText) <= budget ? headingText : truncateUtf8(headingText, budget);
	return { text, includedFiles: [], omittedFiles: allNames.slice(), truncatedFiles: [] };
}
