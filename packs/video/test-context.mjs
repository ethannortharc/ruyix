// A narrow plugin-test context, not a Cordis lifecycle replacement. A sibling service is
// readable only when this plugin or an ancestor inject scope declared it. Keep the
// production framework out of runtime dependencies while making bootstrap mistakes fail CI.
export function pluginContext(services, injected = []) {
  const allowed = new Set(injected)
  return new Proxy({
    effect: fn => fn(),
    inject(deps, fn) {
      if (deps.some(name => services[name] == null)) return
      return fn(pluginContext(services, [...allowed, ...deps]))
    },
  }, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || Reflect.has(target, key)) return Reflect.get(target, key, receiver)
      if (!allowed.has(key)) throw new Error(`cannot get property "${key}" without inject`)
      return services[key]
    },
  })
}
