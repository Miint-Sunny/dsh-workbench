/**
 * 浏览器视口尺寸（feat#161）的纯逻辑：尺寸预设、横竖对调、自定义的范围检查、缩放比例的计算，
 * 以及套在网页框上的样式。界面和 DOM 的部分见 browser-viewport-client.test.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_VIEWPORT_AUTO, BROWSER_VIEWPORT_CONTAINER_KEYS, BROWSER_VIEWPORT_FRAME_KEYS, BROWSER_VIEWPORT_MARGIN,
  BROWSER_VIEWPORT_MAX, BROWSER_VIEWPORT_MIN, BROWSER_VIEWPORT_PRESETS,
  browserViewportContainerStyle, browserViewportCustom, browserViewportFit, browserViewportFrameStyle,
  browserViewportMenuItems, browserViewportOrient, browserViewportOrientation, browserViewportPercent, browserViewportPreset,
} from '../src/client/browser-viewport-model.js'

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} ≠ ${expected}`)

test('预设：手机 375 × 812、平板 768 × 1024、桌面 1280 × 800，选中后是各自的原方向', () => {
  assert.deepEqual(BROWSER_VIEWPORT_PRESETS, [
    { id: 'phone', width: 375, height: 812 },
    { id: 'tablet', width: 768, height: 1024 },
    { id: 'desktop', width: 1280, height: 800 },
  ])
  assert.deepEqual(browserViewportPreset('phone'), { preset: 'phone', width: 375, height: 812 })
  assert.deepEqual(browserViewportPreset('tablet'), { preset: 'tablet', width: 768, height: 1024 })
  assert.deepEqual(browserViewportPreset('desktop'), { preset: 'desktop', width: 1280, height: 800 })
  assert.deepEqual(browserViewportPreset('auto'), BROWSER_VIEWPORT_AUTO)
  assert.equal(browserViewportPreset('custom'), undefined, '自定义要给宽高，不能只按名字选')
  assert.equal(browserViewportPreset('watch'), undefined)
})

test('默认是自动：没有宽高，不能被改动', () => {
  assert.deepEqual(BROWSER_VIEWPORT_AUTO, { preset: 'auto' })
  assert.ok(Object.isFrozen(BROWSER_VIEWPORT_AUTO))
})

test('方向：高大于等于宽是竖向，宽大于高是横向；自动没有方向', () => {
  assert.equal(browserViewportOrientation(browserViewportPreset('phone')), 'portrait')
  assert.equal(browserViewportOrientation(browserViewportPreset('tablet')), 'portrait')
  assert.equal(browserViewportOrientation(browserViewportPreset('desktop')), 'landscape')
  assert.equal(browserViewportOrientation({ preset: 'custom', width: 500, height: 500 }), 'portrait', '正方形算竖向')
  assert.equal(browserViewportOrientation(BROWSER_VIEWPORT_AUTO), undefined)
})

test('横竖对调：宽和高互换，预设名不变；已经是那个方向就不动；自动不动', () => {
  const phone = browserViewportPreset('phone')
  const landscape = browserViewportOrient(phone, 'landscape')
  assert.deepEqual(landscape, { preset: 'phone', width: 812, height: 375 })
  assert.equal(browserViewportOrient(landscape, 'landscape'), landscape, '已经是横向：原样返回')
  assert.deepEqual(browserViewportOrient(landscape, 'portrait'), phone)
  assert.equal(browserViewportOrient(phone, 'portrait'), phone)
  // 桌面原本是横向，换成竖向就是 800 × 1280。
  assert.deepEqual(browserViewportOrient(browserViewportPreset('desktop'), 'portrait'), { preset: 'desktop', width: 800, height: 1280 })
  assert.deepEqual(browserViewportOrient({ preset: 'custom', width: 300, height: 900 }, 'landscape'), { preset: 'custom', width: 900, height: 300 })
  assert.equal(browserViewportOrient(BROWSER_VIEWPORT_AUTO, 'landscape'), BROWSER_VIEWPORT_AUTO, '自动时方向灰着，改不了')
  // 对调两次回到原样（不会越对调越偏）。
  const tablet = browserViewportPreset('tablet')
  assert.deepEqual(browserViewportOrient(browserViewportOrient(tablet, 'landscape'), 'portrait'), tablet)
  // 对调不改原对象。
  assert.deepEqual(phone, { preset: 'phone', width: 375, height: 812 })
})

test('自定义：宽和高都是 240 到 3840 的整数，边界值算对；输入前后的空格忽略', () => {
  assert.equal(BROWSER_VIEWPORT_MIN, 240)
  assert.equal(BROWSER_VIEWPORT_MAX, 3840)
  assert.deepEqual(browserViewportCustom('375', '812'), { ok: true, state: { preset: 'custom', width: 375, height: 812 } })
  assert.deepEqual(browserViewportCustom('240', '3840'), { ok: true, state: { preset: 'custom', width: 240, height: 3840 } })
  assert.deepEqual(browserViewportCustom('3840', '240'), { ok: true, state: { preset: 'custom', width: 3840, height: 240 } })
  assert.deepEqual(browserViewportCustom(' 400 ', '\t600\n'), { ok: true, state: { preset: 'custom', width: 400, height: 600 } })
  assert.deepEqual(browserViewportCustom('0400', '600'), { ok: true, state: { preset: 'custom', width: 400, height: 600 } }, '前导 0 按十进制读')
})

test('自定义：超出范围、不是整数的输入不改尺寸，错误按宽、高分别给出', () => {
  assert.deepEqual(browserViewportCustom('239', '812'), { ok: false, errors: { width: 'range' } })
  assert.deepEqual(browserViewportCustom('375', '3841'), { ok: false, errors: { height: 'range' } })
  assert.deepEqual(browserViewportCustom('120', '900'), { ok: false, errors: { width: 'range' } }, '样稿 5 的例子')
  assert.deepEqual(browserViewportCustom('120', '5000'), { ok: false, errors: { width: 'range', height: 'range' } })
  assert.deepEqual(browserViewportCustom('99999999999999999999', '812'), { ok: false, errors: { width: 'range' } })
  for (const text of ['', '   ', 'abc', '375.5', '3e2', '-300', '+400', '37 5', '١٢٣']) {
    assert.deepEqual(browserViewportCustom(text, '812'), { ok: false, errors: { width: 'integer' } }, JSON.stringify(text))
    assert.deepEqual(browserViewportCustom('375', text), { ok: false, errors: { height: 'integer' } }, JSON.stringify(text))
  }
  assert.deepEqual(browserViewportCustom('abc', '5000'), { ok: false, errors: { width: 'integer', height: 'range' } })
  assert.deepEqual(browserViewportCustom(undefined, null), { ok: false, errors: { width: 'integer', height: 'integer' } })
})

test('缩放比例：按卡片内容区去掉留白后放得下为准，取宽、高里更紧的那个，最大 100%', () => {
  assert.equal(BROWSER_VIEWPORT_MARGIN, 16)
  const phone = browserViewportPreset('phone')
  // 样稿 3 的情形：手机 375 × 812 放进 422 × 600 的内容区，高更紧：(600 - 16) / 812。
  near(browserViewportFit(phone, { width: 422, height: 600 }), 584 / 812)
  near(browserViewportFit(browserViewportPreset('tablet'), { width: 422, height: 600 }), 406 / 768, '平板：宽更紧')
  near(browserViewportFit(browserViewportPreset('desktop'), { width: 422, height: 600 }), 406 / 1280)
  near(browserViewportFit({ preset: 'custom', width: 3840, height: 2160 }, { width: 422, height: 600 }), 406 / 3840, '3840 也能缩，没有 25% 的下限')
  assert.equal(browserViewportFit(phone, { width: 2000, height: 2000 }), 1, '卡片比视口大：不放大，留白')
  assert.equal(browserViewportFit(phone, { width: 391, height: 828 }), 1, '刚好放下：100%')
  near(browserViewportFit(phone, { width: 380, height: 828 }), 364 / 375, '差一点放下')
  assert.equal(browserViewportFit(BROWSER_VIEWPORT_AUTO, { width: 422, height: 600 }), undefined, '自动不缩放')
})

test('缩放比例：卡片还没有大小（藏着、还没排版）时算不出来，不去套一个 0', () => {
  const phone = browserViewportPreset('phone')
  assert.equal(browserViewportFit(phone, { width: 0, height: 0 }), undefined)
  assert.equal(browserViewportFit(phone, { width: 16, height: 600 }), undefined, '去掉留白后没有宽度')
  assert.equal(browserViewportFit(phone, { width: 422, height: 10 }), undefined)
  assert.equal(browserViewportFit(phone, { width: Number.NaN, height: 600 }), undefined)
  assert.equal(browserViewportFit(phone, undefined), undefined)
})

test('缩放百分比：四舍五入成整数，不显示 0%', () => {
  assert.equal(browserViewportPercent(1), 100)
  assert.equal(browserViewportPercent(584 / 812), 72)
  assert.equal(browserViewportPercent(0.3156), 32)
  assert.equal(browserViewportPercent(0.495), 50)
  assert.equal(browserViewportPercent(0.004), 1)
  assert.equal(browserViewportPercent(0.0001), 1)
})

test('套在网页框上的样式：按视口宽高排版，居中，再按比例缩小；用 transform，不用 setZoomFactor', () => {
  const style = browserViewportFrameStyle(browserViewportPreset('phone'), 0.5)
  assert.deepEqual(style, {
    position: 'absolute', left: '50%', top: '50%', flex: 'none',
    width: '375px', height: '812px',
    transform: 'translate(-50%, -50%) scale(0.5)', transformOrigin: 'center',
  })
  assert.equal(browserViewportFrameStyle({ preset: 'custom', width: 1024, height: 768 }, 584 / 812).transform, 'translate(-50%, -50%) scale(0.719212)', '比例保留 6 位小数')
  assert.equal(browserViewportFrameStyle(browserViewportPreset('desktop'), 1).transform, 'translate(-50%, -50%) scale(1)')
  // 样式的键都登记在 FRAME_KEYS 里：还原时一个不剩地清掉，不动官方原有的 display、border 等。
  assert.deepEqual(Object.keys(style).sort(), [...BROWSER_VIEWPORT_FRAME_KEYS].sort())
  assert.ok(!BROWSER_VIEWPORT_FRAME_KEYS.includes('display') && !BROWSER_VIEWPORT_FRAME_KEYS.includes('border'))
})

test('套在网页框上的样式：自动或还没有比例时没有样式（交给官方的样式）', () => {
  assert.equal(browserViewportFrameStyle(BROWSER_VIEWPORT_AUTO, 1), undefined)
  assert.equal(browserViewportFrameStyle(browserViewportPreset('phone'), undefined), undefined)
  assert.equal(browserViewportFrameStyle(browserViewportPreset('phone'), 0), undefined)
  assert.equal(browserViewportFrameStyle(browserViewportPreset('phone'), Number.NaN), undefined)
})

test('网页框外面的容器：作定位参照并裁掉溢出；键也登记好', () => {
  assert.deepEqual(browserViewportContainerStyle(), { position: 'relative', overflow: 'hidden' })
  assert.deepEqual(Object.keys(browserViewportContainerStyle()).sort(), [...BROWSER_VIEWPORT_CONTAINER_KEYS].sort())
})

test('菜单项：自动、手机、平板、桌面、自定义，选中的是当前的预设（横竖对调后仍是它）', () => {
  const ids = items => items.map(item => item.id)
  const checked = items => items.filter(item => item.checked).map(item => item.id)
  const auto = browserViewportMenuItems(BROWSER_VIEWPORT_AUTO)
  assert.deepEqual(ids(auto), ['auto', 'phone', 'tablet', 'desktop', 'custom'])
  assert.deepEqual(checked(auto), ['auto'])
  assert.deepEqual(auto.find(item => item.id === 'tablet'), { id: 'tablet', width: 768, height: 1024, checked: false })
  assert.deepEqual(auto.find(item => item.id === 'auto'), { id: 'auto', checked: true })
  assert.deepEqual(checked(browserViewportMenuItems(browserViewportOrient(browserViewportPreset('phone'), 'landscape'))), ['phone'])
  assert.deepEqual(checked(browserViewportMenuItems(browserViewportPreset('desktop'))), ['desktop'])
  assert.deepEqual(checked(browserViewportMenuItems({ preset: 'custom', width: 300, height: 900 })), ['custom'])
  // 预设一行写的是预设本来的尺寸，不随横竖变。
  const landscapePhone = browserViewportMenuItems(browserViewportOrient(browserViewportPreset('phone'), 'landscape'))
  assert.deepEqual(landscapePhone.find(item => item.id === 'phone'), { id: 'phone', width: 375, height: 812, checked: true })
})
