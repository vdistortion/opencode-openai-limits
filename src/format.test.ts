import assert from "node:assert/strict"
import { test } from "node:test"
import { resetLabel, stackedBar, usageBar } from "./format.ts"

test("bar handles empty, partial and full usage", () => {
  assert.equal(usageBar(0, 4), "░░░░")
  assert.equal(usageBar(50, 4), "██░░")
  assert.equal(usageBar(100, 4), "████")
})

test("bar bounds usage and handles missing values", () => {
  assert.equal(usageBar(-10, 4), "░░░░")
  assert.equal(usageBar(120, 4), "████")
  assert.equal(usageBar(null, 4), "░░░░")
  assert.equal(usageBar(NaN, 4), "░░░░")
})

test("stacked bar keeps primary and weekly halves independent", () => {
  assert.deepEqual(stackedBar(50, 25, 4), [
    { top: true, bottom: true },
    { top: true, bottom: false },
    { top: false, bottom: false },
    { top: false, bottom: false },
  ])
  assert.deepEqual(stackedBar(null, 100, 1), [{ top: false, bottom: true }])
  assert.deepEqual(stackedBar(120, -1, 1), [{ top: true, bottom: false }])
})

test("weekly reset uses days from 24 hours, primary stays in hours", () => {
  const timestamp = (minutes: number) => minutes * 60
  assert.equal(resetLabel(timestamp(23 * 60 + 59), 0, true), "23h 59m")
  assert.equal(resetLabel(timestamp(24 * 60), 0, true), "1d 0h")
  assert.equal(resetLabel(timestamp(50 * 60 + 8), 0, true), "2d 2h")
  assert.equal(resetLabel(timestamp(50 * 60 + 8), 0), "50h 8m")
})

test("reset handles absent timestamps, expired windows and minutes", () => {
  assert.equal(resetLabel(null, 0), "")
  assert.equal(resetLabel(NaN, 0), "")
  assert.equal(resetLabel(1, 2000, true), "0m")
  assert.equal(resetLabel(8 * 60, 0), "8m")
})
