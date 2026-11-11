import { Marked } from "marked"
import DOMPurify from "dompurify"
import hljs from "highlight.js/lib/common"
import { toFileUrl } from "../lib/paths"

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// Keep the file renderer independent of the chat's global marked extensions.
const parser = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s+/)[0].toLowerCase()
      const body = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text)
      return `<pre><code class="hljs">${body}</code></pre>`
    },
  },
})

export function markdownTarget(path: string, href: string): { kind: "file" | "external" | "anchor"; value: string } | null {
  if (href.startsWith("#")) return { kind: "anchor", value: href.slice(1) }
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", value: href }
  // No arbitrary native protocols, script URLs or protocol-relative URLs.
  if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith("//")) return null
  try {
    const url = new URL(href.replace(/\\/g, "/"), toFileUrl(path))
    if (url.protocol !== "file:") return null
    return { kind: "file", value: decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1") }
  } catch {
    return null
  }
}

export function renderMarkdown(text: string, path: string): string {
  const fragment = DOMPurify.sanitize(parser.parse(text, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "span", "strong", "em", "del", "s", "input", "sup", "sub", "details", "summary"],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "type", "checked", "disabled", "start", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
  fragment.querySelectorAll("input").forEach(input => {
    if (input.type !== "checkbox") input.remove()
    else input.disabled = true
  })
  fragment.querySelectorAll("img").forEach(img => {
    const src = img.getAttribute("src") ?? ""
    const target = markdownTarget(path, src)
    if (target?.kind === "file" && src) {
      img.removeAttribute("src")
      img.setAttribute("data-markdown-image", target.value)
    } else if (!/^https?:/i.test(src) && !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src)) {
      img.removeAttribute("src")
    }
  })
  const container = document.createElement("div")
  container.append(fragment)
  return container.innerHTML
}
