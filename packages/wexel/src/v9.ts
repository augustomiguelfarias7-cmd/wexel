export interface V9Document {
  html: string;
  css?: string;
  title?: string;
}

export interface V9RenderResult {
  element: HTMLElement;
  dispose(): void;
}

/** Executor web V9: combina HTML e CSS sem executar scripts automaticamente. */
export class V9Executor {
  createDocument(document: V9Document): string {
    const title = document.title ?? "Wexel V9";
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${document.css ?? ""}</style></head><body>${document.html}</body></html>`;
  }

  render(document: V9Document, container: HTMLElement): V9RenderResult {
    const frame = globalThis.document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = this.createDocument(document);
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    container.appendChild(frame);
    return { element: frame, dispose: () => frame.remove() };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
