import { useEffect, useRef } from 'react'

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.0);
    a *= 0.5;
  }
  return v;
}

float stars(vec2 uv, float scale) {
  vec2 p = uv * scale;
  vec2 g = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = hash21(g);
  float on = step(0.94, h);
  vec2 pos = (vec2(hash21(g + 1.3), hash21(g + 2.7)) - 0.5) * 0.6;
  float d = length(f - pos);
  float star = smoothstep(0.025, 0.004, d);
  float brightness = 0.5 + 0.5 * hash21(g + 9.1);
  return on * star * brightness;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;

  // planet limb: huge circle far below the frame, gentle arc along the bottom
  float R = 3.2;
  vec2 pc = vec2(0.06, -R - 0.42);
  float d = length(uv - pc) - R; // signed height above the limb

  // sky: near-black zenith, faintly lifting toward the horizon
  vec3 col = mix(
    vec3(0.005, 0.008, 0.007),
    vec3(0.016, 0.023, 0.020),
    smoothstep(0.75, -0.05, uv.y)
  );

  // slow high-altitude haze
  vec2 np = uv * 1.3 + vec2(t * 0.005, 0.0);
  float n = fbm(np + fbm(np * 1.6) * 0.4);
  col += smoothstep(0.55, 1.0, n) * vec3(0.015, 0.040, 0.033) * 0.45;

  // stars wheel around a celestial pole off the upper-left; the near layer
  // turns a touch faster than the far one for parallax depth
  vec2 pole = vec2(-0.45, 0.62);
  vec2 rel = uv - pole;

  float angNear = t * 0.0022;
  vec2 qNear = vec2(
    rel.x * cos(angNear) - rel.y * sin(angNear),
    rel.x * sin(angNear) + rel.y * cos(angNear)
  ) + pole;

  float angFar = t * 0.0009;
  vec2 qFar = vec2(
    rel.x * cos(angFar) - rel.y * sin(angFar),
    rel.x * sin(angFar) + rel.y * cos(angFar)
  ) + pole;

  float skyMask = smoothstep(0.02, 0.14, d);
  col += vec3(0.85, 1.0, 0.95) * stars(qNear, 14.0) * 0.55 * skyMask;
  col += vec3(1.0) * stars(qFar + 4.7, 30.0) * 0.30 * skyMask;

  // sunrise hotspot drifting slowly along the limb
  float sunX = 0.20 + 0.04 * sin(t * 0.03);
  float hot = exp(-5.5 * abs(uv.x - sunX));

  // slow "breathing" of the light — two offset sine waves plus a whisper of
  // shimmer, like the atmosphere refracting as the planet turns
  float live = 0.92 + 0.055 * sin(t * 0.13) + 0.025 * sin(t * 0.43 + 2.0);
  float shimmer = 0.94 + 0.06 * noise(vec2(t * 0.30, uv.y * 2.5));

  // atmosphere: narrow glow concentrated at the bright point on the limb
  vec3 glowCol = mix(vec3(0.075, 0.082, 0.078), vec3(0.62, 0.58, 0.50), hot);
  col += glowCol * exp(-max(d, 0.0) * 3.2) * 0.10 * live;
  col += glowCol * exp(-max(d, 0.0) * 9.0) * (0.14 + 0.40 * hot) * live;

  // soft column of light rising from the brightest point
  float pillar = exp(-abs(uv.x - sunX) * 16.0) * exp(-max(d, 0.0) * 2.2);
  col += vec3(0.60, 0.57, 0.50) * pillar * 0.12 * live * shimmer;

  // thin crisp horizon line
  col += vec3(0.96, 0.92, 0.84) * exp(-abs(d) * 200.0) * (0.16 + 0.60 * hot) * live;

  // planet body: clean two-tone gradient — soft lit crescent under the
  // sunrise, falling off into near-black toward the bottom
  float body = smoothstep(0.002, -0.002, d);
  float lit = exp(d * 3.0) * (0.4 + 0.6 * exp(-1.4 * abs(uv.x - sunX)));
  vec3 bodyCol = mix(
    vec3(0.003, 0.004, 0.004),
    vec3(0.042, 0.054, 0.048),
    lit
  );
  bodyCol += glowCol * exp(d * 9.0) * 0.08;
  col = mix(col, bodyCol, body);

  // vignette
  col *= mix(0.6, 1.0, smoothstep(1.25, 0.3, length(uv)));

  // dither: breaks up 8-bit banding on the slow dark gradients
  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function SpaceShader(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false })
    if (!gl || gl.isContextLost()) return

    const vert = compile(gl, gl.VERTEX_SHADER, VERT)
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const program = gl.createProgram()
    if (!vert || !frag || !program) return
    gl.attachShader(program, vert)
    gl.attachShader(program, frag)
    gl.linkProgram(program)
    gl.useProgram(program)

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'u_res')
    const uTime = gl.getUniformLocation(program, 'u_time')

    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    const start = performance.now()
    let raf = 0
    const loop = (): void => {
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, (performance.now() - start) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      // No loseContext() here: under StrictMode the remount would reuse the
      // same (now dead) context. Stopping the loop is enough; GC frees the GL.
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
    }
  }, [])

  return (
    <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
  )
}

export default SpaceShader
