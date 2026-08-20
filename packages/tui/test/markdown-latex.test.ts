import assert from "node:assert";
import { describe, it } from "node:test";
import { Markdown } from "../src/components/markdown.js";
import { latexToUnicode } from "../src/latex.js";
import { defaultMarkdownTheme } from "./test-themes.js";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderPlain(text: string, width = 80): string[] {
	const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
	return markdown.render(width).map(stripAnsi);
}

describe("latexToUnicode", () => {
	it("converts symbols, big operators, and scripts", () => {
		assert.strictEqual(latexToUnicode("y_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}"), "yₜ = ∑ₖ₌₀ᵂ⁻¹ wₖ ⊙ xₜ₋ₖ");
	});

	it("converts greek letters and relations", () => {
		assert.strictEqual(latexToUnicode("\\alpha \\leq \\beta \\implies \\gamma \\to \\infty"), "α ≤ β ⇒ γ → ∞");
	});

	it("renders operator names as plain words", () => {
		assert.strictEqual(latexToUnicode("O(n \\log n)"), "O(n log n)");
		assert.strictEqual(latexToUnicode("\\max_i f(x_i)"), "maxᵢ f(xᵢ)");
	});

	it("renders fractions linearly with parentheses only when needed", () => {
		assert.strictEqual(latexToUnicode("\\frac{a}{b}"), "a/b");
		assert.strictEqual(latexToUnicode("\\frac{x+1}{2}"), "(x+1)/2");
		assert.strictEqual(latexToUnicode("\\frac{1}{2} m v^2"), "½ m v²");
	});

	it("renders square roots", () => {
		assert.strictEqual(latexToUnicode("\\sqrt{x}"), "√x");
		assert.strictEqual(latexToUnicode("\\sqrt{x^2+1}"), "√(x²+1)");
		assert.strictEqual(latexToUnicode("\\sqrt[3]{8}"), "∛8");
	});

	it("unwraps text commands and styles alphabets", () => {
		assert.strictEqual(latexToUnicode("\\text{softmax}(QK^T / \\sqrt{d_k})"), "softmax(QKᵀ / √dₖ)");
		assert.strictEqual(latexToUnicode("\\mathbb{R}^d"), "ℝᵈ");
		assert.strictEqual(latexToUnicode("\\mathcal{L}"), "ℒ");
		assert.strictEqual(latexToUnicode("\\mathbf{W} x"), "𝐖 x");
	});

	it("applies accents as combining characters", () => {
		assert.strictEqual(latexToUnicode("\\hat{y}"), "ŷ");
		assert.strictEqual(latexToUnicode("\\vec{x}"), "x⃗");
	});

	it("keeps TeX notation for scripts without Unicode forms", () => {
		assert.strictEqual(latexToUnicode("\\nabla_\\theta J(\\theta)"), "∇_θ J(θ)");
		assert.strictEqual(latexToUnicode("x_{best}"), "x_{best}");
	});

	it("drops sizing commands and keeps delimiters", () => {
		assert.strictEqual(latexToUnicode("\\left( \\frac{1}{N} \\sum_{i=1}^N x_i \\right)"), "( 1/N ∑ᵢ₌₁ᴺ xᵢ )");
	});

	it("turns aligned environments into multiple lines", () => {
		assert.strictEqual(
			latexToUnicode("\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}").trim(),
			"a = b + c \n d = e",
		);
	});

	it("degrades unknown commands to their name", () => {
		assert.strictEqual(latexToUnicode("\\foobar x"), "foobar x");
	});

	it("handles escaped braces", () => {
		assert.strictEqual(latexToUnicode("x \\in \\{1, \\dots, K\\}"), "x ∈ {1, …, K}");
	});

	it("collapses insignificant whitespace from spacing commands", () => {
		assert.strictEqual(latexToUnicode("\\int_0^1 x^2 \\, dx = \\frac{1}{3}"), "∫₀¹ x² dx = ⅓");
	});

	it("renders matrix environments as rows", () => {
		assert.strictEqual(latexToUnicode("\\begin{pmatrix}\n1 & 2 \\\\\n3 & 4\n\\end{pmatrix}").trim(), "1 2 \n3 4");
	});

	it("treats accented characters as simple fraction operands", () => {
		assert.strictEqual(latexToUnicode("\\frac{\\hat{x}}{2}"), "x̂/2");
	});

	it("keeps underscores literal inside text-mode commands", () => {
		assert.strictEqual(latexToUnicode("\\text{x_i}"), "x_i");
		assert.strictEqual(latexToUnicode("\\text{learning_rate} = 0.1"), "learning_rate = 0.1");
		assert.strictEqual(latexToUnicode("\\mathrm{x_i}"), "xᵢ");
	});
});

describe("Markdown math rendering", () => {
	it("renders \\[ ... \\] display math as a Unicode block", () => {
		const lines = renderPlain("Intro:\n\n\\[\ny_t = \\sum_{k=0}^{W-1} w_k \\odot x_{t-k}\n\\]\n\nAfter.");
		assert.ok(lines.some((line) => line.includes("W-1")));
		assert.ok(lines.some((line) => line.includes("yₜ = ∑  wₖ ⊙ xₜ₋ₖ")));
		assert.ok(lines.some((line) => line.includes("k=0")));
		assert.ok(!lines.some((line) => line.includes("\\sum")));
		assert.ok(lines.some((line) => line.includes("After.")));
	});

	it("renders $$ ... $$ display math as a Unicode block", () => {
		const lines = renderPlain("$$\nE = mc^2\n$$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders display math with CRLF line endings", () => {
		const lines = renderPlain("\\[\r\nE = mc^2\r\n\\]\r\n");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders inline \\( ... \\) math", () => {
		const lines = renderPlain("where the weights \\(w_k\\) are shared");
		assert.ok(lines.some((line) => line.includes("where the weights wₖ are shared")));
	});

	it("renders inline $ ... $ math", () => {
		const lines = renderPlain("the value $x_i \\cdot y$ grows");
		assert.ok(lines.some((line) => line.includes("the value xᵢ · y grows")));
	});

	it("keeps underscores inside math out of emphasis", () => {
		const lines = renderPlain("\\[ a_k = b_k + x_k \\]");
		assert.ok(lines.some((line) => line.includes("aₖ = bₖ + xₖ")));
	});

	it("does not treat dollar amounts as math", () => {
		const lines = renderPlain("between $5 and $10 total");
		assert.ok(lines.some((line) => line.includes("between $5 and $10 total")));
	});

	it("does not match a closing dollar followed by a digit", () => {
		const lines = renderPlain("prices $5,$10 listed");
		assert.ok(lines.some((line) => line.includes("prices $5,$10 listed")));
	});

	it("does not parse single-dollar math across a line break", () => {
		const lines = renderPlain("Cost $5\nprice$ total");
		assert.ok(lines.some((line) => line.includes("Cost $5")));
		assert.ok(lines.some((line) => line.includes("price$ total")));
	});

	it("leaves unterminated display math as plain text while streaming", () => {
		const lines = renderPlain("$$\ny_t = \\sum");
		assert.ok(lines.some((line) => line.includes("$$")));
	});

	it("renders math inside list items", () => {
		const lines = renderPlain("- gradient \\(\\nabla_\\theta J\\) step");
		assert.ok(lines.some((line) => line.includes("- gradient ∇_θ J step")));
	});

	it("renders display math blocks inside list items", () => {
		const lines = renderPlain(
			"1. The sum:\n\n   \\[\n   \\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n   \\]\n\n2. Next item",
		);
		assert.ok(lines.some((line) => line.includes("n(n+1)")));
		assert.ok(lines.some((line) => line.includes("∑  k = ─")));
		assert.ok(lines.some((line) => line.includes("k=1")));
		assert.ok(!lines.some((line) => line.includes("\\sum")));
		assert.ok(lines.some((line) => line.includes("2. Next item")));
	});

	it("renders $$ display math inside list items", () => {
		const lines = renderPlain("- item:\n\n  $$\n  E = mc^2\n  $$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
	});

	it("renders display math indented four spaces instead of treating it as code", () => {
		const lines = renderPlain("Math:\n\n    \\[\n    E = mc^2\n    \\]\n\n    $$\n    a^2 + b^2 = c^2\n    $$");
		assert.ok(lines.some((line) => line.includes("E = mc²")));
		assert.ok(lines.some((line) => line.includes("a² + b² = c²")));
		assert.ok(!lines.some((line) => line.includes("\\[")));
	});

	it("still lexes indented code that is not math as a code block", () => {
		const lines = renderPlain("Code:\n\n    const x = 1;\n    return x;");
		assert.ok(lines.some((line) => line.includes("const x = 1;")));
	});

	it("leaves LaTeX inside fenced code blocks untouched", () => {
		const lines = renderPlain("```latex\n\\[\nE = mc^2\n\\]\n```");
		assert.ok(lines.some((line) => line.includes("\\[")));
		assert.ok(lines.some((line) => line.includes("E = mc^2")));
		assert.ok(!lines.some((line) => line.includes("E = mc²")));
	});

	it("leaves math delimiters inside inline code spans untouched", () => {
		const lines = renderPlain("run `echo $PATH$HOME` and `$x_i$` now");
		assert.ok(lines.some((line) => line.includes("echo $PATH$HOME")));
		assert.ok(lines.some((line) => line.includes("$x_i$")));
	});

	it("joins multi-line inline math with spaces", () => {
		const lines = renderPlain("a \\(x +\ny\\) b");
		assert.ok(lines.some((line) => line.includes("a x + y b")));
	});

	it("falls back to code/codeBlock theme styles", () => {
		const markdown = new Markdown("$$x + y$$", 0, 0, defaultMarkdownTheme);
		const lines = markdown.render(80);
		const mathLine = lines.find((line) => stripAnsi(line).includes("x + y"));
		assert.ok(mathLine);
		assert.ok(mathLine.includes("\x1b[32m"));
	});

	it("produces identical output for streamed and fresh renders", () => {
		const part1 = "Some intro text.\n\n$$\ny_t = \\sum_{k=0}^{W-1} w_k\n$$\n\n";
		const part2 = "And inline \\(x_i\\) afterwards.";
		const streamed = new Markdown(part1, 0, 0, defaultMarkdownTheme);
		streamed.render(80);
		streamed.setText(part1 + part2);
		const streamedLines = streamed.render(80);
		const freshLines = new Markdown(part1 + part2, 0, 0, defaultMarkdownTheme).render(80);
		assert.deepStrictEqual(streamedLines, freshLines);
	});

	it("stacks display fractions and operator limits", () => {
		const lines = renderPlain(String.raw`\[
\sum_{i=0}^n x_i = \frac{x^2+1}{x-1}
\]`).map((line) => line.trimEnd());

		assert.ok(lines.some((line) => line.includes(" n")));
		assert.ok(lines.some((line) => line.includes("∑  xᵢ =")));
		assert.ok(lines.some((line) => line.includes("i=0")));
		assert.ok(lines.some((line) => line.includes("────")));
		assert.ok(lines.some((line) => line.includes("x-1")));
	});

	it("composes display matrices and renders cases", () => {
		const matrix = renderPlain(String.raw`\[
A=\begin{pmatrix}1&200\\3000&4\end{pmatrix}.
\]`).map((line) => line.trimEnd());
		assert.ok(matrix.some((line) => line.includes("A = ⎛ 1    │ 200 ⎞")));
		assert.ok(matrix.some((line) => line.includes("⎝ 3000 │ 4   ⎠.")));

		const cases = renderPlain(String.raw`\[
f(x)=\begin{cases}a & x<0 \\ b & x=0 \\ c & x>0\end{cases}
\]`).map((line) => line.trimEnd());
		assert.ok(cases.some((line) => line.includes("⎧ a if x < 0")));
		assert.ok(cases.some((line) => line.includes("⎨ b if x = 0")));
		assert.ok(cases.some((line) => line.includes("⎩ c if x > 0")));
	});

	it("preserves unsupported LaTeX with its delimiters", () => {
		const inlineSource = String.raw`Unknown $x + \unknown{y}$ after`;
		assert.ok(renderPlain(inlineSource).some((line) => line.includes(inlineSource)));

		const block = renderPlain(String.raw`Before

\[
x + \unknown{y}
\]

after`).map((line) => line.trimEnd());
		assert.ok(block.some((line) => line.includes("\\[")));
		assert.ok(block.some((line) => line.includes(String.raw`x + \unknown{y}`)));
		assert.ok(block.some((line) => line.includes("\\]")));
	});

	it("switches from a raw streamed delimiter to rendered math when it closes", () => {
		const markdown = new Markdown(String.raw`Map \(\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
		assert.ok(
			markdown
				.render(80)
				.map(stripAnsi)
				.some((line) => line.includes(String.raw`\(\mathbb{C}^3`)),
		);

		markdown.setText(String.raw`Map \(\mathbb{C}^3\)`);
		const complete = markdown.render(80).map(stripAnsi);
		assert.ok(complete.some((line) => line.includes("Map ℂ³")));
		assert.ok(!complete.some((line) => line.includes("\\mathbb")));
	});

	it("allows the upgraded renderer to be disabled", () => {
		const markdown = new Markdown(String.raw`Map $\mathbb{C}^3$`, 0, 0, defaultMarkdownTheme, undefined, {
			renderLatex: false,
		});
		assert.ok(
			markdown
				.render(80)
				.map(stripAnsi)
				.some((line) => line.includes(String.raw`$\mathbb{C}^3$`)),
		);
	});
});
