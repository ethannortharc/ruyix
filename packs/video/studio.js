const L = (en, zh) => ({ en, zh })
export const studio = {
  id: 'video', name: L('Video Studio', '视频工作室'), icon: 'Clapperboard',
  collections: {
    projects: { title: L('Projects', '剪辑项目'), fields: [
      { name: 'title', type: 'text', label: L('Title', '标题'), required: true },
      { name: 'brief', type: 'textarea', label: L('Audience, story and editing brief', '受众、叙事和剪辑要求') },
      { name: 'sources', type: 'file', multiple: true, label: L('Footage (up to 25 MiB each)', '素材（每个最多 25 MiB）') },
      { name: 'sourceFolder', type: 'text', label: L('Local source folder for larger footage', '较大素材所在的本地目录'), hint: L('Absolute path; source files are read only', '绝对路径；只读取素材，不会修改原文件') },
      { name: 'sourcePaths', type: 'textarea', label: L('Relative video paths, one per line', '素材相对路径，每行一个'), hint: L('Inside the selected source folder; up to 20 files, 10 GiB each', '仅限所选目录内；最多 20 个素材，每个 10 GiB') },
      { name: 'aspect', type: 'select', label: L('Format', '画幅'), default: 'landscape', options: [{ value: 'landscape', label: '16:9' }, { value: 'portrait', label: '9:16' }, { value: 'square', label: '1:1' }] },
      { name: 'targetSeconds', type: 'text', label: L('Initial length (seconds)', '初稿时长（秒）'), default: '60' },
      { name: 'assisted', type: 'bool', label: L('Agent-assisted edit plan', '智能体辅助剪辑方案'), default: false },
      { name: 'when', type: 'datetime', label: L('Delivery date', '计划交付时间') },
      { name: 'status', type: 'status', label: L('Status', '状态'), default: 'idea', values: [
        { value: 'idea', label: L('Ready to start', '待剪辑'), tone: 'neutral' }, { value: 'editing', label: L('Editing', '剪辑中'), tone: 'progress' }, { value: 'ready', label: L('Approved deliverable', '审核通过'), tone: 'success' }, { value: 'archived', label: L('Archived', '归档'), tone: 'neutral' },
      ] },
    ] },
    deliverables: { title: L('Deliverables', '成片'), runs: 'video.edit' },
  },
  materials: { kinds: ['video', 'audio', 'image', 'text'] },
  start: [{ id: 'edit', label: L('Edit video', '开始剪辑'), workflow: 'video.edit', from: 'projects', title: 'title', text: 'brief', fields: { sources: 'sources', sourceFolder: 'sourceFolder', sourcePaths: 'sourcePaths', aspect: 'aspect', targetSeconds: 'targetSeconds', assisted: 'assisted' }, status: { start: 'editing', done: 'ready', failed: 'idea' } }],
  home: ['start', 'working', { view: 'board', collection: 'projects', by: 'status' }, { view: 'list', collection: 'deliverables' }, { view: 'library' }, { view: 'calendar', collection: 'projects', at: 'when' }, 'history'],
  remind: [{ collection: 'projects', at: 'when', unless: ['ready', 'archived'] }],
}
