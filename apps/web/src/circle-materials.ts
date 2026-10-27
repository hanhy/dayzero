import * as THREE from 'three';

export const NODE_COLOR = '#9bd8ce';

function installAnalyticCircle(
  material: THREE.PointsMaterial | THREE.SpriteMaterial,
  glow = false,
) {
  const isPoint = material instanceof THREE.PointsMaterial;
  material.customProgramCacheKey = () =>
    `dayzero-circle-v1:${isPoint ? 'point' : 'sprite'}:${glow ? 'glow' : 'disc'}`;
  material.onBeforeCompile = (shader) => {
    if (!isPoint) {
      // Sprite UVs remain camera-facing and square at every zoom level.
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec2 vCircleUv;',
        )
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\nvCircleUv = uv;',
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vCircleUv;',
      );
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphatest_fragment>',
      /* glsl */ `
        vec2 circleUv = ${isPoint ? 'gl_PointCoord' : 'vCircleUv'} - vec2(0.5);
        float circleDistance = length(circleUv);
        // Recompute a pixel-wide soft edge, rather than magnifying a bitmap mask.
        float edgeWidth = max(fwidth(circleDistance), 0.00001);
        float coverage = 1.0 - smoothstep(0.5 - edgeWidth, 0.5, circleDistance);
        ${glow ? 'coverage *= exp(-dot(circleUv, circleUv) / 0.055);' : ''}
        diffuseColor.a *= coverage;
        if (diffuseColor.a <= 0.0) discard;
        #include <alphatest_fragment>
      `,
    );
  };
  return material;
}

export function createRoundPointMaterial() {
  const material = new THREE.PointsMaterial({
    color: NODE_COLOR,
    size: 1.5,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  installAnalyticCircle(material);
  return material;
}

export function createRoundSpriteMaterial(glow = false) {
  const material = new THREE.SpriteMaterial({
    color: NODE_COLOR,
    transparent: true,
    depthWrite: false,
  });
  installAnalyticCircle(material, glow);
  return material;
}
