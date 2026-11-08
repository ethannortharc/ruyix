import { createPack } from './pack.js'
import { studio } from './studio.js'
import { fileResponse } from '@ruyix/workbench/file'
import { sourceForPlayback } from './lib/media.js'
export const inject = ['ruyixWorkbench', 'connection']
export { createPack }
export function apply(ctx) {
  ctx.inject(['ruyixWorkbench'], inner => {
    inner.effect(() => inner.ruyixWorkbench.registerPack(createPack()), 'video: workflow')
    // Range streaming reads only sources already imported by this run. Request parameters never contain paths.
    inner.connection.fetch.register({
      path: '/api/ruyix-video/source', methods: ['GET'], requestBody: 'buffered',
      fetch(request) {
        try {
          const params = new URL(request.url, 'http://ruyix.invalid').searchParams
          const source = sourceForPlayback(inner.ruyixWorkbench.run(params.get('run')), params.get('source'))
          return fileResponse(source.path, { name: source.name, range: request.headers.get('range') })
        } catch (e) { return Response.json({ error: e.message }, { status: 409 }) }
      },
    })
  })
  ctx.inject(['ruyixStudio'], inner => inner.effect(() => inner.ruyixStudio.register(studio), 'video: studio'))
}
