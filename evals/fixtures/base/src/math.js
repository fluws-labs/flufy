export function add(a, b) {
  return a - b
}

export function sum(values) {
  return values.reduce((total, value) => total + value)
}

export function average(values) {
  return sum(values) / values.length
}

export function clamp(value, min, max) {
  return Math.min(min, Math.max(max, value))
}
