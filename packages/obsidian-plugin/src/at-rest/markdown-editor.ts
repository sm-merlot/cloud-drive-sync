// Markdown editing for private notes: syntax-aware styling in the spirit of
// Obsidian's source mode (headings sized, bold/italic, code, quotes, links,
// list markers), list continuation on Enter, and [[wiki links]] marked.
//
// Only the markdown grammar is bundled (@codemirror/lang-markdown +
// @lezer/markdown). @codemirror/language, @lezer/highlight and the editor
// core are Obsidian's own copies at runtime (esbuild externals), so there's a
// single CodeMirror instance.
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate, keymap } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";

const style = HighlightStyle.define([
	{ tag: t.heading1, fontSize: "var(--h1-size)", fontWeight: "var(--h1-weight)", color: "var(--h1-color)" },
	{ tag: t.heading2, fontSize: "var(--h2-size)", fontWeight: "var(--h2-weight)", color: "var(--h2-color)" },
	{ tag: t.heading3, fontSize: "var(--h3-size)", fontWeight: "var(--h3-weight)", color: "var(--h3-color)" },
	{ tag: t.heading4, fontSize: "var(--h4-size)", fontWeight: "var(--h4-weight)", color: "var(--h4-color)" },
	{ tag: t.heading5, fontSize: "var(--h5-size)", fontWeight: "var(--h5-weight)", color: "var(--h5-color)" },
	{ tag: t.heading6, fontSize: "var(--h6-size)", fontWeight: "var(--h6-weight)", color: "var(--h6-color)" },
	{ tag: t.strong, fontWeight: "var(--bold-weight, bold)" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
	{ tag: t.link, color: "var(--link-color)" },
	{ tag: t.url, color: "var(--link-external-color)", textDecoration: "underline" },
	{ tag: t.monospace, fontFamily: "var(--font-monospace)", backgroundColor: "var(--code-background)" },
	{ tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
	{ tag: t.list, color: "var(--list-marker-color, var(--text-muted))" },
	{ tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--text-faint)" },
]);

const wikiLink = new MatchDecorator({
	regexp: /!?\[\[[^\]\n]+\]\]/g,
	decoration: Decoration.mark({ class: "cds-wikilink" }),
});

const wikiLinks = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = wikiLink.createDeco(view);
		}
		update(u: ViewUpdate) {
			this.decorations = wikiLink.updateDeco(u, this.decorations);
		}
	},
	{ decorations: (v) => v.decorations },
);

export function markdownEditing(): Extension {
	return [markdownLanguage, syntaxHighlighting(style), keymap.of(markdownKeymap), wikiLinks];
}
