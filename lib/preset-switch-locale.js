// The built-in Standard preset has no display metadata on the Host. Its names and
// descriptions are from the official settings.agentPreset client dictionaries.
const standard = {
  en: { name: "Standard mode",
    description: "Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed." },
  zh: { name: "标准模式",
    description: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。" },
  ja: { name: "標準モード",
    description: "コード、ファイル、情報を扱います。検索、編集、ターミナルコマンドなどのツールを必要に応じて利用でき、ほとんどのタスクに適しています。" },
  es: { name: "Modo estándar",
    description: "Trabaje con código, archivos e información. Adecuado para la mayoría de las tareas, con búsqueda, edición, comandos de terminal y otras herramientas disponibles según sea necesario." },
  fr: { name: "Mode standard",
    description: "Travaillez avec du code, des fichiers et des informations. Convient à la plupart des tâches, avec recherche, édition, commandes de terminal et autres outils disponibles selon les besoins." },
  de: { name: "Standardmodus",
    description: "Arbeiten Sie mit Code, Dateien und Informationen. Geeignet für die meisten Aufgaben, da bei Bedarf Suche, Bearbeitung, Terminalbefehle und andere Tools verfügbar sind." },
  ru: { name: "Стандартный режим",
    description: "Работайте с кодом, файлами и информацией. Подходит для большинства задач, с поиском, редактированием, командами терминала и другими инструментами, доступными по мере необходимости." },
  pt: { name: "Modo padrão",
    description: "Trabalhe com código, arquivos e informações. Adequado para a maioria das tarefas, com pesquisa, edição, comandos de terminal e outras ferramentas disponíveis conforme necessário." },
}

export function presetDisplayLocale(ctx, request) {
  const entry = [...(ctx.get('loader')?.entries() ?? [])].find(row => row.options.id === 'locale')
  const preference = entry?.options.config?.preference
  const languages = (request.headers.get('accept-language') ?? '').split(',').map(range => {
    const [tag, weight] = range.trim().split(';')
    const q = weight === undefined ? 1 : Number(weight.trim().replace(/^q=/i, ''))
    return { tag, q }
  }).filter(range => range.q > 0 && range.q <= 1).sort((a, b) => b.q - a.q)
  for (const tag of [preference, ...languages.map(range => range.tag), Intl.DateTimeFormat().resolvedOptions().locale]) {
    const language = tag?.toLowerCase().split(/[-_]/)[0]
    if (Object.hasOwn(standard, language)) return language
  }
  return 'en'
}

export function presetDisplay(preset, locale) {
  if (preset.id === 'standard' && preset.name === undefined) return { id: preset.id, ...standard[locale] }
  return { id: preset.id, name: preset.name ?? preset.id, description: preset.description ?? '' }
}
