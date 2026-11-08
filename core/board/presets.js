// The built-in definitions: a few datasets and one dashboard over the generic connections (a GitLab, a Kubernetes
// cluster). Nothing here names a project, a cluster or a service — those are settings ({{settings.…}}), filled where the
// dataset runs. What a board keeps is only the fields listed: counts, titles, states and links.

const t = (zh, en) => ({ zh, en })

export const DATASETS = {
  'gitlab-open-mrs': {
    kind: 'dataset', name: 'gitlab-open-mrs', version: '1.0.0', title: t('待合并的 MR（GitLab）', 'Open merge requests (GitLab)'),
    connector: 'gitlab', op: 'mrs.list',
    params: { project: '{{settings.gitlab.project}}', state: 'opened', limit: 100 },
    fields: { id: 'string', ref: 'string', title: 'string', author: 'person', state: 'enum', target: 'string', pipeline: 'enum', updated: 'time', url: 'url' },
    labels: { ref: t('编号', 'MR'), title: t('标题', 'Title'), author: t('作者', 'Author'), target: t('目标分支', 'Target'), pipeline: t('流水线', 'Pipeline'), updated: t('更新', 'Updated') },
    key: 'id', refresh: '10m', history: { keep: ['count'], days: 30 },
  },
  'k8s-workloads': {
    kind: 'dataset', name: 'k8s-workloads', version: '1.0.0', title: t('工作负载（Kubernetes）', 'Workloads (Kubernetes)'),
    connector: 'k8s', op: 'workloads', params: { namespace: '{{settings.k8s.namespace}}' },
    fields: { name: 'string', namespace: 'string', kind: 'enum', ready: 'number', desired: 'number', image: 'string', updated: 'time' },
    labels: { name: t('名称', 'Name'), kind: t('类型', 'Kind'), ready: t('就绪', 'Ready'), desired: t('期望', 'Desired'), image: t('镜像', 'Image'), updated: t('更新', 'Updated') },
    key: 'name', refresh: '5m', history: { keep: ['ready'], days: 14 },
  },
  'k8s-warnings': {
    kind: 'dataset', name: 'k8s-warnings', version: '1.0.0', title: t('集群告警事件（Kubernetes）', 'Cluster warnings (Kubernetes)'),
    connector: 'k8s', op: 'events', params: { namespace: '{{settings.k8s.namespace}}', type: 'Warning', limit: 200 },
    fields: { at: 'time', type: 'enum', reason: 'string', object: 'string', message: 'string' },
    labels: { at: t('时间', 'At'), reason: t('原因', 'Reason'), object: t('对象', 'Object'), message: t('内容', 'Message') },
    key: 'at', refresh: '5m',
  },
}

/** Rows a dashboard is checked against before it is kept (and a page can preview with). */
export const SAMPLES = {
  'gitlab-open-mrs': [
    { id: '11', ref: '!11', title: 'Add the export page', author: 'me', state: 'opened', target: 'main', pipeline: 'success', updated: '2026-10-12T09:30:00Z', url: 'https://code.example/me/app/-/merge_requests/11' },
    { id: '12', ref: '!12', title: 'Fix the date picker', author: 'me', state: 'opened', target: 'main', pipeline: 'failed', updated: '2026-10-12T07:10:00Z', url: 'https://code.example/me/app/-/merge_requests/12' },
  ],
  'k8s-workloads': [
    { name: 'api', namespace: 'apps', kind: 'Deployment', ready: 3, desired: 3, image: 'registry.example/api:1.4.2', updated: '2026-10-12T08:00:00Z' },
    { name: 'worker', namespace: 'apps', kind: 'Deployment', ready: 1, desired: 2, image: 'registry.example/worker:1.4.2', updated: '2026-10-12T08:05:00Z' },
  ],
  'k8s-warnings': [{ at: '2026-10-12T08:06:00Z', type: 'Warning', reason: 'BackOff', object: 'pod/worker-7f9c', message: 'Back-off restarting failed container' }],
}

export const DASHBOARDS = {
  'dev-overview': {
    kind: 'dashboard', name: 'dev-overview', version: '1.0.0', title: t('开发概览', 'Development overview'), renderer: '>=1',
    datasets: { mrs: 'gitlab-open-mrs@^1', loads: 'k8s-workloads@^1', warn: 'k8s-warnings@^1', runs: 'core.runs@*' },
    pages: [
      {
        id: 'overview', title: t('概览', 'Overview'),
        widgets: [
          { id: 'open-mrs', data: 'mrs', view: 'count', size: 's', title: t('待合并的 MR', 'Open merge requests') },
          { id: 'red-mrs', data: 'mrs', view: 'count', filter: { pipeline: ['failed'] }, size: 's', title: t('流水线失败的 MR', 'With a failed pipeline') },
          { id: 'warnings', data: 'warn', view: 'count', size: 's', title: t('集群告警', 'Cluster warnings') },
          { id: 'by-target', data: 'mrs', view: 'breakdown', by: 'target', size: 'm', title: t('MR · 按目标分支', 'Merge requests by target') },
          { id: 'workloads', data: 'loads', view: 'table', columns: ['name', 'kind', 'ready', 'desired', 'image'], size: 'l', title: t('工作负载', 'Workloads') },
          {
            id: 'mrs', data: 'mrs', view: 'table', columns: ['ref', 'title', 'author', 'pipeline', 'updated'], sort: '-updated', limit: 10, size: 'l',
            title: t('最近的 MR', 'Recent merge requests'), actions: [{ op: 'url.open', args: { url: '$row.url' } }],
          },
          { id: 'runs', data: 'runs', view: 'runs', size: 'l', title: t('最近的运行', 'Recent runs') },
        ],
      },
    ],
  },
}

/** Workspace presets (a layout an app brings): none built in — the parts that bring one register it (ruyixShell.preset). */
export const WORKSPACES = {}

/** Every built-in by kind and name. */
export const PRESETS = { dataset: DATASETS, dashboard: DASHBOARDS, workspace: WORKSPACES }
