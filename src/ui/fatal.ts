/** Full-screen message for conditions the app cannot run under. */
export function showFatal(title: string, detail: string): void {
  const el = document.createElement('div')
  el.className = 'fatal'
  const h = document.createElement('h1')
  h.textContent = title
  const p = document.createElement('p')
  p.textContent = detail
  el.append(h, p)
  document.getElementById('ui')!.replaceChildren(el)
}
