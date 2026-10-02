/**
 * 标识符生成。convId 的形状是跨端契约的一部分（小程序把它当 convId 持久化并参与 KDF），
 * 所以"长度 12 的十六进制 + `c_` 前缀"这类看起来无聊的断言其实是在守协议。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONVERSATION_ID_PREFIX,
  looksLikeConversationId,
  newCmdId,
  newConversationId,
  newHostId,
} from '../../src/identity/ids.js'

test('convId 是 c_ + 12 位小写 hex，且实际只靠 6 字节随机（48 bit）', () => {
  const id = newConversationId()
  assert.ok(id.startsWith(CONVERSATION_ID_PREFIX))
  assert.match(id, /^c_[0-9a-f]{12}$/)
  assert.equal(id.length, 14)
  assert.ok(looksLikeConversationId(id))
})

test('20 000 个 convId 无重复（碰撞概率按 48 bit 空间应当极低，出现重复就是随机源坏了）', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 20_000; i++) seen.add(newConversationId())
  assert.equal(seen.size, 20_000)
})

test('looksLikeConversationId 只做形状粗筛，不承担安全判断', () => {
  for (const bad of ['', 'c_', 'c_zzzzzzzzzzzz', 'x_a1b2c3d4e5f6', 'c_a1b2c3d4e5f67', 'a1b2c3d4e5f6']) {
    assert.equal(looksLikeConversationId(bad), false, bad)
  }
})

test('hostId 是 8 位 hex；cmdId 每次不同', () => {
  assert.match(newHostId(), /^[0-9a-f]{8}$/)
  const ids = new Set<string>()
  for (let i = 0; i < 1000; i++) ids.add(newCmdId())
  assert.equal(ids.size, 1000)
})
