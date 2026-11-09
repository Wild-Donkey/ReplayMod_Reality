// Deck uses a 512-unit Mercator world with y pointing north. The density
// vertices use normalized world coordinates with y pointing south.
export function footprintProjectionMatrix(matrix: readonly number[]): number[] {
  return matrix.map((value, index) => {
    if (index < 4) return value * 512;
    if (index < 8) return value * -512;
    if (index < 12) return value;
    return value + matrix[index - 8] * 512;
  });
}

export function normalizedMercator(longitude: number, latitude: number) {
  return {
    x: (180 + longitude) / 360,
    y: (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360))) / 360,
  };
}
