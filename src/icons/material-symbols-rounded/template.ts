export function template(content: string) {
  const element = document.createElement('template');
  element.innerHTML = content;
  return element;
}
