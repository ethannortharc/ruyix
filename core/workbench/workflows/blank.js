// The core's own base workflow: the request goes in (intake), steps of the person's own run (agent, script, approval,
// branch, parallel — built in the workflow editor), the report comes out. A domain pack's workflow can be a base
// too; this one has no domain at all.
import { actions, intake, renderReport, report } from './common.js'

export default {
  id: 'blank',
  title: 'Blank',
  description: 'A request, steps of your own, a report.',
  noun: 'task',
  success: 'done',
  stages: [intake, report],
  roles: {},
  actions,
  report: renderReport,
}
