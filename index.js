const fs = require('fs')
const path = require('path')
const chokidar = require('chokidar')
const Dao = require('@live-change/dao')

const app = require('@live-change/framework').app()

function createFilter(filterSpec) {
  if(!filterSpec) return () => true
  if(typeof filterSpec == 'string') {
    const regexp = new RegExp(filterSpec)
    return (entry) => entry.name.match(regexp)
  } else if(typeof filterSpec == 'function') {
    return filterSpec
  } else if(filterSpec instanceof RegExp) {
    return (entry) => entry.name.match(filterSpec)
  } else {
    if(filterSpec.code) {
      const func = eval(filterSpec.code)
      if(filterSpec.parameters) return (entry) => func(entry, ...parameters)
      else return eval(filterSpec.code)
    } else if(filterSpec.name) {
      const regexp = new RegExp(filterSpec.name)
      if(filterSpec.type == 'dir') return (entry) => entry.name.match(regexp) && entry.isDirectory
      else if(filterSpec.type == 'file') return (entry) => entry.name.match(regexp) && !entry.isDirectory
      else return (entry) => entry.name.match(regexp)
    } else {
      if(filterSpec.type == 'dir') return (entry) => entry.isDirectory()
      else if(filterSpec.type == 'file') return (entry) => entry.isFile()
    }
  }
}

async function getStat(filename) {
  return fs.promises.stat(filename)
}

async function observableFile(filename, func) {
  const observable = new Dao.ObservableValue()
  let watcher
  const oldDispose = observable.dispose
  const oldRespawn = observable.respawn
  const watch = async () => {
    if(watcher) watcher.close()
    const stat = await fs.promises.stat(filename)
    const newValue = await func(filename, stat)
    if(JSON.stringify(observable.value) != JSON.stringify(newValue)) {
      observable.set(newValue)
    }
    watcher = chokidar.watch(filename, { depth: 0, alwaysStat: true })
    watcher.on('change', async (name, stat) => {
      if(name != filename) return
      const newValue = await func(name, stat)
      if(JSON.stringify(observable.value) != JSON.stringify(newValue)) {
        observable.set(newValue)
      }
    })
  }
  observable.dispose = () => {
    if(watcher) watcher.close()
    watcher = null
    oldDispose.call(observable)
  }
  observable.respawn = () => {
    watch()
    oldRespawn.call(oldRespawn)
  }
  await watch()
  return observable
}

async function observableStats(filename) {
  return observableFile(filename, (name, stat) => stat)
}

async function getContent(filename) {
  return fs.promises.readFile(filename, { encoding: 'utf8' })
}

async function observableContent(filename, decoder = x=>x) {
  return observableFile(filename,
      (name, stat) => fs.promises.readFile(name, { encoding: 'utf8' })
      .then(result => decoder(result))
    )
}

const entryCompare = (a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0

async function getList(dir, filter, mapper) {
  const list = await fs.promises.readdir(dir, { withFileTypes: true })
  let entries = await Promise.all(list.map(async entry => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    stat: await fs.promises.stat(path.resolve(dir, entry.name))
  })))
  if(mapper) entries = await Promise.all(entries.map(entry => mapper(entry)))
  if(filter) entries = entries.filter(filter)
  return entries.sort(entryCompare)
}

async function observableList(dir, filter, mapper) {
  const observable = new Dao.ObservableList()
  let watcher
  const oldDispose = observable.dispose
  const oldRespawn = observable.respawn
  const watch = async () => {
    if(watcher) watcher.close()
    const list = await getList(dir, filter, mapper)
    observable.set(list)
    watcher = chokidar.watch(dir, { depth: 0, alwaysStat: true })
    watcher.on('add', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDirectory: false,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && filter(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('change', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDirectory: false,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && fitler(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('unlink', async (name) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      observable.removeByField('name', name)
    })
    watcher.on('addDir', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDirectory: true,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && filter(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('unlinkDir', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      observable.removeByField('name', name)
    })
  }
  observable.dispose = () => {
    if(watcher) watcher.close()
    watcher = null
    oldDispose.call(observable)
  }
  observable.respawn = () => {
    watch()
    oldRespawn.call(oldRespawn)
  }
  await watch()
  return observable
}

async function getTree(dir, prefix = '', filter, mapper) {
  const list = await fs.promises.readdir(dir, { withFileTypes: true })
  const entriesLists = await Promise.all(list.map(async entry => {
    if(entry.isDirectory()) {
      const tree = await getTree(path.resolve(dir, entry.name), prefix + entry.name + '/')
      return [{
        name: prefix + entry.name,
        isDirectory: true,
        stat: await fs.promises.stat(path.resolve(dir, entry.name))
      }].concat(tree)
    } else {
      return {
        name: prefix + entry.name,
        isDirectory: false,
        stat: await fs.promises.stat(path.resolve(dir, entry.name))
      }
    }
  }))
  let entries = entriesLists.flat()
  if(mapper) entries = await Promise.all(entries.map(entry => mapper(entry)))
  if(filter) entries = entries.filter(filter)
  return entries.sort(entryCompare)
}

async function observableTree(dir, filter, mapper) {
  const observable = new Dao.ObservableList()
  let watcher
  const oldDispose = observable.dispose
  const oldRespawn = observable.respawn
  const watch = async () => {
    if(watcher) watcher.close()
    const list = await getTree(dir, filter, mapper)
    observable.set(list)
    watcher = chokidar.watch(dir, { depth: 99, alwaysStat: true })
    watcher.on('add', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDirectory: false,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && filter(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('change', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDirectory: false,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && filter(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('unlink', async (name) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      observable.removeByField('name', name)
    })
    watcher.on('addDir', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      let entry = {
        name,
        isDir: true,
        stat
      }
      if(mapper) entry = await mapper(entry)
      if(filter && filter(entry)) observable.putByField('name', name, entry)
    })
    watcher.on('unlinkDir', async (name, stat) => {
      if(path.dirname(name) != dir) return
      name = path.relative(dir, name)
      observable.removeByField('name', name)
    })
  }
  observable.dispose = () => {
    if(watcher) watcher.close()
    watcher = null
    oldDispose.call(observable)
  }
  observable.respawn = () => {
    watch()
    oldRespawn.call(oldRespawn)
  }
  await watch()
  return observable
}

const filesystemDao = new Dao.SimpleDao({
  values: {
    stat: {
      get: (filename) => getStat(filename),
      observable: (filename) => observableStat(filename)
    },
    content: {
      get: (filename, decoder = x=>x ) => getContent(filename, decoder),
      observable: (filename, decoder = x=>x ) => observableContent(filename, decoder)
    },
    list: {
      get: (dir, filterSpec, mapper) => getList(dir, createFilter(filterSpec), mapper),
      observable: (dir, filterSpec, mapper) => observableList(dir, createFilter(filterSpec), mapper)
    },
    tree: {
      get: (dir, filterSpec, mapper) => getTree(dir, '', createFilter(filterSpec), mapper),
      observable: (dir, filterSpec, mapper) => observableTree(dir, createFilter(filterSpec), mapper)
    }
  },
  methods: {}
})

module.exports = function(app, services) {
  app.dao.definition.filesystem = {
    type: "local",
    source: filesystemDao
  }
}
