export class BrailleBreathe {
  private frame = 0
  private readonly levels = [0x00, 0x40, 0x44, 0x46, 0x4e, 0x5e, 0x7e, 0x7f, 0xff]
  step(): string {
    const t = this.frame++ / 20
    let line = ''
    for (let i = 0; i < 9; i++) {
      const d = Math.abs(i - 4) / 4
      const breathe = (Math.sin(t * Math.PI * 2) + 1) / 2
      const intensity = breathe * (1 - d * 0.5)
      const idx = Math.min(Math.floor(intensity * (this.levels.length - 1)), this.levels.length - 1)
      line += String.fromCharCode(0x2800 + this.levels[idx])
    }
    return line
  }
  free() { }
}
