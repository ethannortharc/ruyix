// A job's live workflow on React Flow: Lead → one lane per role → that role's tasks
// in order → delivery. Every node animates with the run it stands for.
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, applyNodeChanges, useReactFlow, useStore, ReactFlowProvider } from '@xyflow/react'
import { CheckCircle2, CircleDashed, Flag, Hourglass, Loader2, Square, XCircle } from 'lucide-react'
import { AccessBadge, Avatar, RuntimeBadge, StatusLine, cx, dur, useT } from './ui.jsx'

export const NowCtx = createContext(Date.now())
const SIZE = { lead: [196, 88], member: [212, 104], task: [216, 96], deliver: [124, 88] }
const GAP_X = 56, GAP_Y = 22, LANE = 6
const TASK_ICON = { done: CheckCircle2, running: Loader2, queued: Hourglass, error: XCircle, idle: Square }
export const taskTone = task => (task.state === 'queued' ? 'idle' : task.state)

function layout(team) {
  const rowH = SIZE.member[1] + GAP_Y
  const height = Math.max(team.members.length * rowH - GAP_Y, SIZE.lead[1])
  const laneTop = i => i * rowH + (height - (team.members.length * rowH - GAP_Y)) / 2
  const memberX = SIZE.lead[0] + GAP_X
  const taskX = memberX + SIZE.member[0] + GAP_X
  const lanes = team.members.map(m => m.tasks.slice(-LANE))
  const longest = Math.max(0, ...lanes.map(l => l.length))
  const deliverX = taskX + longest * (SIZE.task[0] + GAP_X)
  const nodes = [{ id: team.lead.id, kind: 'lead', x: 0, y: (height - SIZE.lead[1]) / 2 }]
  const edges = []
  team.members.forEach((m, i) => {
    const y = laneTop(i)
    nodes.push({ id: m.id, kind: 'member', member: m, hidden: m.tasks.length - lanes[i].length, x: memberX, y })
    edges.push({ from: team.lead.id, to: m.id, tone: m.running ? 'running' : m.state === 'error' ? 'error' : 'idle', kind: 'org' })
    let prev = m.id
    lanes[i].forEach((task, j) => {
      const id = `task:${task.id}`
      nodes.push({ id, kind: 'task', task, x: taskX + j * (SIZE.task[0] + GAP_X), y: y + (SIZE.member[1] - SIZE.task[1]) / 2 })
      edges.push({ from: prev, to: id, tone: taskTone(task), kind: prev === m.id ? 'own' : 'seq' })
      prev = id
    })
    const last = lanes[i].at(-1)
    edges.push({ from: prev, to: 'deliver', tone: last?.state === 'done' ? 'done' : 'idle', kind: 'out' })
  })
  // Declared dependencies cross lanes: upstream task → the task that builds on it.
  const shown = new Set(nodes.map(n => n.id))
  for (const task of team.tasks) {
    for (const dep of task.after || []) {
      if (shown.has(`task:${dep}`) && shown.has(`task:${task.id}`)) edges.push({ from: `task:${dep}`, to: `task:${task.id}`, tone: task.state === 'queued' ? 'waiting' : taskTone(task), kind: 'dep' })
    }
  }
  const allDone = team.tasks.length > 0 && team.tasks.every(task => task.status !== 'running' && task.status !== 'queued') && !team.lead.running
  nodes.push({ id: 'deliver', kind: 'deliver', x: deliverX, y: (height - SIZE.deliver[1]) / 2 })
  return { nodes, edges, allDone, width: deliverX + SIZE.deliver[0], height }
}

const LeadNode = memo(({ data }) => {
  const t = useT()
  const now = useContext(NowCtx)
  const a = data.agent
  return (
    <div className={cx('ah-node ah-node-member ah-node-lead', `ah-tone-${a.state}`, data.selected && 'ah-node-selected')}>
      <div className="ah-node-head">
        <Avatar name="lead" state={a.state} size={26} lead />
        <div className="ah-node-title"><b>{t('lead')}</b><span className="ah-mono">{a.model}</span></div>
      </div>
      <StatusLine agent={a} now={now} />
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const MemberNode = memo(({ data }) => {
  const t = useT()
  const now = useContext(NowCtx)
  const m = data.member
  return (
    <div className={cx('ah-node ah-node-member', `ah-tone-${m.state}`, data.selected && 'ah-node-selected')}>
      <Handle type="target" position={Position.Left} />
      <div className="ah-node-head">
        <Avatar name={m.name} state={m.state} size={26} />
        <div className="ah-node-title"><b>{m.name}</b><span title={m.def.role}>{m.def.role || m.def.agent}</span></div>
      </div>
      <div className="ah-node-badges"><RuntimeBadge runtime={m.def.runtime} model={m.model} effort={m.def.effort} /><AccessBadge access={m.def.access} /></div>
      <StatusLine agent={m} now={now} />
      {data.hidden > 0 && <span className="ah-node-more">{t('flow.earlier', { n: data.hidden })}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const TaskNode = memo(({ data }) => {
  const t = useT()
  const now = useContext(NowCtx)
  const { task } = data
  const tone = taskTone(task)
  const Icon = TASK_ICON[task.state] || CircleDashed
  return (
    <div className={cx('ah-node ah-node-task', `ah-tone-${tone}`, data.selected && 'ah-node-selected')} title={String(task.task || '').slice(0, 300)}>
      <Handle type="target" position={Position.Left} />
      <div className="ah-node-head">
        <Icon size={14} className={cx('ah-node-icon', task.running && 'ah-spin')} />
        <span className="ah-task-id">{task.id}</span>
        {task.after?.length > 0 && <span className="ah-node-after" title={task.after.join(', ')}>↳ {task.after.join(', ')}</span>}
        {task.startedAt && <span className="ah-node-time">{dur((task.endedAt || now) - task.startedAt)}</span>}
      </div>
      <div className="ah-node-subject">{task.title}</div>
      {task.running || task.state === 'error'
        ? <StatusLine agent={task} now={now} />
        : <div className="ah-node-foot">{t(`task.${task.status}`)}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
})

const DeliverNode = memo(({ data }) => {
  const t = useT()
  return (
    <div className={cx('ah-node ah-node-deliver', data.allDone ? 'ah-tone-done' : 'ah-tone-idle')}>
      <Handle type="target" position={Position.Left} />
      {data.allDone ? <CheckCircle2 size={20} /> : <Flag size={18} />}
      <b>{t('flow.deliver')}</b>
      <span>{t('tasks.progress', { done: data.done, total: data.total })}</span>
    </div>
  )
})

const nodeTypes = { lead: LeadNode, member: MemberNode, task: TaskNode, deliver: DeliverNode }
const mmClass = n => (n.type === 'task' ? `ah-mm-${taskTone(n.data.task)}` : n.type === 'member' ? `ah-mm-${n.data.member.state}` : n.type === 'lead' ? `ah-mm-${n.data.agent.state}` : 'ah-mm-idle')

function useDark() {
  const read = () => document.body.hasAttribute('data-ds-dark-theme')
  const [dark, setDark] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

function Canvas({ team, selected, onSelect }) {
  const dark = useDark()
  const { setViewport } = useReactFlow()
  const moved = useRef({})
  const graph = useMemo(() => layout(team), [team])
  const computed = useMemo(() => graph.nodes.map(n => ({
    id: n.id,
    type: n.kind,
    position: moved.current[n.id] || { x: n.x, y: n.y },
    data: n.kind === 'lead' ? { agent: team.lead, selected: selected === n.id }
      : n.kind === 'member' ? { member: n.member, hidden: n.hidden, selected: selected === n.id }
        : n.kind === 'task' ? { task: n.task, selected: selected === n.id }
          : { allDone: graph.allDone, done: team.done, total: team.tasks.length },
  })), [graph, selected, team])
  const [nodes, setNodes] = useState(computed)
  // every sync builds a new team object: a node being dragged keeps where the hand is, not where the layout puts it
  useEffect(() => setNodes(prev => {
    const held = new Map(prev.filter(n => n.dragging).map(n => [n.id, n]))
    return held.size ? computed.map(n => (held.has(n.id) ? { ...n, position: held.get(n.id).position, dragging: true } : n)) : computed
  }), [computed])
  const edges = useMemo(() => graph.edges.map(e => ({
    id: `${e.from}>${e.to}`, source: e.from, target: e.to, animated: e.tone === 'running',
    className: cx('ah-edge', `ah-edge-${e.tone}`, `ah-edge-${e.kind}`),
  })), [graph])
  // Fit on shape or pane-size change, but never below a readable zoom: a wider graph
  // starts at its Lead (left-aligned) and pans, instead of shrinking into unreadable text.
  const shape = graph.nodes.map(n => n.id).join('|')
  const w = useStore(state => state.width)
  const h = useStore(state => state.height)
  const pane = `${Math.round(w / 20)}x${Math.round(h / 20)}`
  useEffect(() => {
    if (!w || !h) return
    const zoom = Math.max(0.72, Math.min(1, (w - 64) / graph.width, (h - 64) / graph.height))
    const x = graph.width * zoom + 64 <= w ? (w - graph.width * zoom) / 2 : 32
    setViewport({ x, y: Math.max(24, (h - graph.height * zoom) / 2), zoom }, { duration: 300 })
  }, [shape, pane])
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} colorMode={dark ? 'dark' : 'light'}
      onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))}
      onNodeDragStop={(_, node) => { moved.current[node.id] = node.position }}
      onNodeClick={(_, node) => node.id !== 'deliver' && onSelect(node.id === selected ? null : node.id)}
      onPaneClick={() => onSelect(null)}
      minZoom={0.3} maxZoom={1.6}
      nodesConnectable={false} proOptions={{ hideAttribution: true }}>
      <Background gap={18} size={1.2} />
      <MiniMap pannable zoomable nodeStrokeWidth={2} className="ah-minimap" style={{ width: 150, height: 96 }} nodeClassName={mmClass} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

export function TeamFlow(props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
