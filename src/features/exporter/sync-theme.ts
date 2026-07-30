// Этап 2 п.2.7: подстановка цветовых токенов на Shikimori.
//
// Перенесено из монолита без изменений. Смысл: все классы `amk-*` из `style.scss`
// опираются на переменные AniList (`--color-foreground`, `--color-text` и так далее).
// На Shikimori их нет, поэтому значения вычисляются из фактической темы страницы и
// вешаются на конкретный узел. Без этого модалка на Shikimori остаётся прозрачно-чёрной.
//
// Функцию зовут два компонента (кнопка и модалка), поэтому она живёт отдельно,
// а не внутри одного из них.

/** Вешает на узел переменные темы, вычисленные из текущего оформления Shikimori. */
export function amkShikiTokens(el: HTMLElement): void {
  const triple = (c: string, fb: string): string => {
    const m = (c || '').match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    return m ? `${m[1]} ${m[2]} ${m[3]}` : fb
  }
  let bg = getComputedStyle(document.body).backgroundColor
  if (!bg || bg === 'transparent' || bg.replace(/\s/g, '').includes('rgba(0,0,0,0)'))
    bg = getComputedStyle(document.documentElement).backgroundColor
  const bgT = triple(bg, '18 18 28')
  const txT = triple(getComputedStyle(document.body).color, '226 232 240')
  const vars: Record<string, string> = {
    '--color-foreground': bgT,
    '--color-background': bgT,
    '--color-background-100': bgT,
    '--color-background-200': bgT,
    '--color-background-300': bgT,
    '--color-text': txT,
    '--color-text-light': txT,
    '--color-blue': '61 187 238',
    '--color-pink': '243 139 168',
    '--color-red': '252 129 129',
    '--color-green': '166 227 161',
    '--color-orange': '246 193 119',
    '--color-purple': '183 148 244',
  }
  for (const k in vars) {
    const val = vars[k]
    if (val !== undefined) el.style.setProperty(k, val)
  }
}
