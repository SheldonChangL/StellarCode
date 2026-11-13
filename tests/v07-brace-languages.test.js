import test from 'node:test'
import assert from 'node:assert/strict'
import { readProjectMetadata } from '../src/core/project.js'
import { openProjectStore } from '../src/storage/project-store.js'
import { parseBraceLanguage, maskBraceSource } from '../src/indexer/brace-languages.js'
import { isTestPath } from '../src/indexer/scanner.js'
import { semanticRepo } from './helpers-v06.js'

// v0.7 lexical tier for Rust, Kotlin and Swift: symbols with exact ranges plus the imports
// that name a repository file. No semantic facts.

const table = (text, language) => Object.fromEntries(parseBraceLanguage(text, language).symbols
  .map(s => [s.qualifiedName, `${s.kind} ${s.startLine}-${s.endLine}${s.exported ? ' pub' : ''}`]))
const specifiers = (text, language) => parseBraceLanguage(text, language).imports.map(i => i.specifier)

test('v0.7 masking keeps offsets and hides braces inside literals and comments', () => {
  const rust = `let a = "}{"; let b = r#"}"{"#; let c = '{'; fn f<'a>(x: &'a str) {} /* { /* } */ { */`
  const maskedRust = maskBraceSource(rust, 'Rust')
  assert.equal(maskedRust.length, rust.length)
  assert.equal(maskedRust.replace(/[^{}]/g, ''), '{}')
  assert.ok(maskedRust.includes(`fn f<'a>(x: &'a str)`))

  const kotlin = 'val a = "x ${ m["}"] } {"; val b = """ { \\"""; val c = \'}\'; fun f() {}'
  assert.equal(maskBraceSource(kotlin, 'Kotlin').replace(/[^{}]/g, ''), '{}')

  const swift = 'let a = "x \\(d["}"]!) {"; let b = #"{ " }"#; func f() {}'
  assert.equal(maskBraceSource(swift, 'Swift').replace(/[^{}]/g, ''), '{}')
})

test('v0.7 Rust: items, impl members, trait requirements and inline modules', () => {
  const text = `use std::fmt;
use crate::store::{Repo, audit::{self, Entry as E}};
pub(crate) mod wire;

pub const LIMIT: usize = 5;

#[derive(Debug)]
pub struct Session<T> {
    inner: T,
}

pub struct Marker;

pub trait Sink {
    fn push(&mut self, item: u8) -> Result<(), fmt::Error>;
    fn flush(&mut self) {}
}

impl<T: Sink> Session<T> {
    pub async fn open(inner: T) -> Self
    where
        T: Send,
    {
        Session { inner }
    }

    fn close(self) {
        fn helper(x: impl Sink) {}
    }
}

impl<T> fmt::Display for Session<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{{session}}")
    }
}

pub unsafe extern "C" fn free<const N: usize>(x: [u8; N]) -> usize { N }

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::sibling::Thing;

    #[test]
    fn opens() {}
}
`
  assert.deepEqual(table(text, 'Rust'), {
    LIMIT: 'constant 5-5 pub',
    Session: 'class 8-10 pub',
    Marker: 'class 12-12 pub',
    Sink: 'interface 14-17 pub',
    'Sink.push': 'method 15-15 pub',
    'Sink.flush': 'method 16-16 pub',
    'Session.open': 'method 20-25 pub',
    'Session.close': 'method 27-29',
    helper: 'function 28-28',
    'Session.fmt': 'method 33-35 pub',
    free: 'function 38-38 pub',
    opens: 'function 46-46'
  })
  // `super::*` inside the inline module names this file; one more `super` leaves it.
  assert.deepEqual(specifiers(text, 'Rust'), ['self::wire', 'std::fmt', 'crate::store::Repo', 'crate::store::audit', 'crate::store::audit::Entry', 'super::sibling::Thing'])
  const entry = parseBraceLanguage(text, 'Rust').imports.find(i => i.specifier.endsWith('Entry'))
  assert.deepEqual(entry.importedNames, [{ importedName: 'Entry', localName: 'E', kind: 'named' }])
})

test('v0.7 Kotlin: classes, companion members, expression bodies and extension functions', () => {
  const text = `package com.app.data

import com.app.model.User
import com.app.util.*
import com.app.net.Client as Http

const val TIMEOUT = 30
private val cache = mutableMapOf<String, User>()

data class Page(val items: List<User>, val next: String?)

class Repo @Inject constructor(
    private val http: Http,
) : Base(),
    Closeable {

    companion object {
        const val TAG = "Repo"
        fun create(): Repo = Repo(Http())
    }

    suspend fun load(id: String): User =
        http.get("users/\${id}")
            .body()

    override fun close() {
        cache.clear()
    }

    private fun \`drops stale entries\`() {}
}

interface Base {
    fun close()
}

fun <T : Comparable<T>> List<T>.second(): T = this[1]

object Registry : Base {
    override fun close() = Unit
}
`
  assert.deepEqual(table(text, 'Kotlin'), {
    TIMEOUT: 'constant 7-7 pub',
    cache: 'constant 8-8',
    Page: 'class 10-10 pub',
    Repo: 'class 12-31 pub',
    'Repo.TAG': 'constant 18-18 pub',
    'Repo.create': 'method 19-19 pub',
    'Repo.load': 'method 22-24 pub',
    'Repo.close': 'method 26-28 pub',
    'Repo.drops stale entries': 'method 30-30',
    Base: 'interface 33-35 pub',
    'Base.close': 'method 34-34 pub',
    second: 'function 37-37 pub',
    Registry: 'class 39-41 pub',
    'Registry.close': 'method 40-40 pub'
  })
  // Import statements, the file's package, then each mentioned name once; declared, imported,
  // annotation and common names are left out.
  assert.deepEqual(specifiers(text, 'Kotlin'), ['com.app.model.User', 'com.app.util.*', 'com.app.net.Client', 'package:com.app.data', 'type:Closeable'])
})

test('v0.7 Swift: types, extensions, initializers and protocol requirements', () => {
  const text = `import Foundation
@testable import KVMCore

public let defaultPort = 24800

public protocol Transport: AnyObject {
    func send(_ data: Data) async throws
    var isOpen: Bool { get }
}

public final class Session: Transport,
    @unchecked Sendable {
    public static let shared = Session(port: defaultPort)
    private(set) var port: Int

    public init(port: Int) {
        self.port = port
    }

    convenience init() { self.init(port: 1) }

    public func send(_ data: Data) async throws {
        let text = "sent \\(data.count) {bytes}"
        log(text)
    }

    class func make() -> Session { Session() }
}

extension Session.State: CustomStringConvertible {
    var description: String { "state" }
    fileprivate func reset<T>(_ value: T) where T: Sendable {
    }
}

private func log(_ text: String) {}

enum Mode { case host, client }
`
  assert.deepEqual(table(text, 'Swift'), {
    defaultPort: 'constant 4-4 pub',
    Transport: 'interface 6-9 pub',
    'Transport.send': 'method 7-7 pub',
    Session: 'class 11-28 pub',
    'Session.shared': 'constant 13-13 pub',
    'Session.init': 'method 20-20 pub',
    'Session.send': 'method 22-25 pub',
    'Session.make': 'method 27-27 pub',
    'State.reset': 'method 32-33',
    log: 'function 36-36',
    Mode: 'class 38-38 pub'
  })
  // Import statements, then each mentioned type name once; own and common types are left out.
  // `Session.State` is a member access; `Session`, `Transport` and `Mode` are declared here.
  assert.deepEqual(specifiers(text, 'Swift'), ['Foundation', 'KVMCore', 'type:CustomStringConvertible'])
})

test('v0.7 test paths for Kotlin and Swift', () => {
  assert.equal(isTestPath('app/src/androidTest/java/com/app/FlowCheck.kt'), true)
  assert.equal(isTestPath('app/src/main/java/com/app/RepoTest.kt'), true)
  assert.equal(isTestPath('Sources/Core/SessionTests.swift'), true)
  assert.equal(isTestPath('app/src/main/java/com/app/Contest.kt'), false)
  assert.equal(isTestPath('src/latest.ts'), false)
})

test('v0.7 index: files, symbols and resolved imports for the three languages', async () => {
  const w = await semanticRepo({
    'crates/core/src/lib.rs': 'pub mod store;\npub fn boot() {}\n',
    'crates/core/src/store.rs': 'mod disk;\nuse crate::boot;\npub struct Repo;\n',
    'crates/core/src/store/disk.rs': 'use super::Repo;\npub fn write(_r: &Repo) {}\n',
    'crates/cli/src/main.rs': 'use core::store::Repo;\nuse std::fmt;\nfn main() {}\n',
    'app/src/main/java/com/app/data/Repo.kt': 'package com.app.data\n\nimport com.app.model.User\nimport android.util.Log\n\nclass Repo {\n    fun load(): User = User()\n}\n',
    'app/src/main/java/com/app/model/User.kt': 'package com.app.model\n\nclass User\n',
    'Sources/Core/Session.swift': 'import Foundation\n\npublic struct Session {\n    public func open() {}\n}\n'
  })
  try {
    const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
    try {
      const languages = Object.fromEntries(db.prepare('SELECT path,language FROM files').all().map(r => [r.path, r.language]))
      assert.equal(languages['crates/core/src/store.rs'], 'Rust')
      assert.equal(languages['app/src/main/java/com/app/data/Repo.kt'], 'Kotlin')
      assert.equal(languages['Sources/Core/Session.swift'], 'Swift')
      const symbols = db.prepare('SELECT file_id,qualified_name,kind,start_line,end_line FROM symbols').all()
      assert.deepEqual({ ...symbols.find(s => s.qualified_name === 'Session.open') }, { file_id: 'Sources/Core/Session.swift', qualified_name: 'Session.open', kind: 'method', start_line: 4, end_line: 4 })
      assert.deepEqual({ ...symbols.find(s => s.qualified_name === 'Repo.load') }, { file_id: 'app/src/main/java/com/app/data/Repo.kt', qualified_name: 'Repo.load', kind: 'method', start_line: 7, end_line: 7 })
      const imports = db.prepare("SELECT source_id,target_id FROM edges WHERE edge_type='imports'").all().map(e => `${e.source_id} -> ${e.target_id}`).sort()
      assert.deepEqual(imports, [
        'app/src/main/java/com/app/data/Repo.kt -> app/src/main/java/com/app/model/User.kt',
        'crates/cli/src/main.rs -> crates/core/src/store.rs',
        'crates/core/src/lib.rs -> crates/core/src/store.rs',
        'crates/core/src/store.rs -> crates/core/src/lib.rs',
        'crates/core/src/store.rs -> crates/core/src/store/disk.rs',
        'crates/core/src/store/disk.rs -> crates/core/src/store.rs'
      ])
      const references = db.prepare("SELECT e.source_id,s.qualified_name FROM edges e JOIN symbols s ON s.symbol_id=e.target_id WHERE e.edge_type='references'").all().map(e => `${e.source_id} -> ${e.qualified_name}`).sort()
      assert.deepEqual(references, [
        'app/src/main/java/com/app/data/Repo.kt -> User',
        'crates/cli/src/main.rs -> Repo',
        'crates/core/src/store.rs -> boot',
        'crates/core/src/store/disk.rs -> Repo'
      ])
      assert.equal(db.prepare('SELECT COUNT(*) c FROM semantic_facts').get().c, 0)
    } finally { db.close() }
  } finally { await w.cleanup() }
})

test('v0.7.1 Swift: type mentions become file edges by module visibility', async () => {
  const w = await semanticRepo({
    'Packages/Core/Sources/Core/Session.swift': 'public struct Session {\n    var mode: Mode\n    var frame: Frame\n}\n',
    'Packages/Core/Sources/Core/Mode.swift': 'public enum Mode { case host }\n',
    // Declared by two modules: visible to Core only through its own copy.
    'Packages/Core/Sources/Core/Frame.swift': 'struct Frame {}\n',
    'Packages/Wire/Sources/Wire/Frame.swift': 'public struct Frame {}\npublic struct Packet {}\n',
    // Imports Core, not Wire: Packet is not visible, Session is.
    'Packages/Core/Tests/CoreTests/SessionTests.swift': 'import Testing\n@testable import Core\n\nstruct SessionTests {\n    let session: Session? = nil\n    let packet: Packet? = nil\n}\n',
    // An app target sees the whole repository; a name with two declarations stays unresolved.
    'Apps/Mac/AppDelegate.swift': 'import Core\n\nfinal class AppDelegate {\n    var session: Session?\n    var frame: Frame?\n    var packet: Packet?\n}\n',
    'Apps/Mac/Session+Log.swift': 'extension Session {\n    func log() {}\n}\n'
  })
  try {
    const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
    try {
      const edges = type => db.prepare('SELECT source_id,target_id FROM edges WHERE edge_type=?').all(type).map(e => `${e.source_id} -> ${e.target_id}`).sort()
      assert.deepEqual(edges('imports'), [
        'Apps/Mac/AppDelegate.swift -> Packages/Core/Sources/Core/Session.swift',
        'Apps/Mac/AppDelegate.swift -> Packages/Wire/Sources/Wire/Frame.swift',
        'Apps/Mac/Session+Log.swift -> Packages/Core/Sources/Core/Session.swift',
        'Packages/Core/Sources/Core/Session.swift -> Packages/Core/Sources/Core/Frame.swift',
        'Packages/Core/Sources/Core/Session.swift -> Packages/Core/Sources/Core/Mode.swift',
        'Packages/Core/Tests/CoreTests/SessionTests.swift -> Packages/Core/Sources/Core/Session.swift'
      ])
      assert.deepEqual(edges('tests'), ['Packages/Core/Tests/CoreTests/SessionTests.swift -> Packages/Core/Sources/Core/Session.swift'])
      const references = db.prepare("SELECT e.source_id,s.qualified_name FROM edges e JOIN symbols s ON s.symbol_id=e.target_id WHERE e.edge_type='references'").all().map(e => `${e.source_id} -> ${e.qualified_name}`).sort()
      assert.ok(references.includes('Apps/Mac/Session+Log.swift -> Session'))
      assert.ok(references.includes('Apps/Mac/AppDelegate.swift -> Packet'))
      assert.ok(!references.includes('Apps/Mac/AppDelegate.swift -> Frame'))
    } finally { db.close() }
  } finally { await w.cleanup() }
})

test('v0.7.2 Kotlin: same-package names, wildcard imports and function imports become file edges', async () => {
  const dir = 'app/src/main/java/com/app'
  const w = await semanticRepo({
    // Same package: no import needed for a class or a composable function.
    [`${dir}/ui/Screen.kt`]: 'package com.app.ui\n\nimport com.app.util.formatName\nimport com.app.model.*\n\nfun Screen(state: ScreenState) {\n    Header(formatName(state.user))\n    val user: User? = null\n    val tag: Tag? = null\n}\n',
    [`${dir}/ui/ScreenState.kt`]: 'package com.app.ui\n\ndata class ScreenState(val user: String)\n',
    [`${dir}/ui/Widgets.kt`]: 'package com.app.ui\n\nfun Header(text: String) {}\n',
    // Wildcard-imported package.
    [`${dir}/model/User.kt`]: 'package com.app.model\n\nclass User\n',
    // Declared twice in the wildcard-imported package: unresolved.
    [`${dir}/model/TagA.kt`]: 'package com.app.model\n\nclass Tag\n',
    [`${dir}/model/TagB.kt`]: 'package com.app.model\n\nclass Tag\n',
    // Imported top-level function: the file is not named after it.
    [`${dir}/util/Strings.kt`]: 'package com.app.util\n\nfun formatName(name: String) = name.trim()\n',
    // Same simple name in another package, not imported: not visible.
    [`${dir}/other/Header.kt`]: 'package com.app.other\n\nclass Header\nclass ScreenState\n'
  })
  try {
    const { db } = await openProjectStore(w.repo, await readProjectMetadata(w.repo), { dirs: w.dirs })
    try {
      const imports = db.prepare("SELECT source_id,target_id FROM edges WHERE edge_type='imports'").all().map(e => `${e.source_id.slice(dir.length + 1)} -> ${e.target_id.slice(dir.length + 1)}`).sort()
      assert.deepEqual(imports, [
        'ui/Screen.kt -> model/User.kt',
        'ui/Screen.kt -> ui/ScreenState.kt',
        'ui/Screen.kt -> ui/Widgets.kt',
        'ui/Screen.kt -> util/Strings.kt'
      ])
      const references = db.prepare("SELECT s.qualified_name FROM edges e JOIN symbols s ON s.symbol_id=e.target_id WHERE e.edge_type='references'").all().map(e => e.qualified_name).sort()
      assert.deepEqual(references, ['Header', 'ScreenState', 'User', 'formatName'])
    } finally { db.close() }
  } finally { await w.cleanup() }
})
