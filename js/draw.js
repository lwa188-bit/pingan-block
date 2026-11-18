(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};

  function fillFittedText(ctx, text, x, y, maxWidth, fontSize, family) {
    let size = fontSize;
    do {
      ctx.font = size + 'px ' + family;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 1;
    } while (size >= 7);
    ctx.fillText(text, x, y, maxWidth);
  }

  function rect(ctx, color, x, y, width, height) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
  }

  function worldY(C, simulation, worldPosition) {
    return C.CAR_Y - (worldPosition - simulation.distance) * C.PIXELS_PER_METER;
  }

  function drawTree(ctx, x, y, variant) {
    rect(ctx, '#263b36', x - 3, y + 8, 6, 12);
    rect(ctx, '#183b32', x - 13, y - 7, 26, 21);
    rect(ctx, variant ? '#3c7950' : '#36704b', x - 10, y - 12, 20, 23);
    rect(ctx, '#4d8c59', x - 6, y - 15, 12, 8);
    rect(ctx, '#66a164', x - 7, y - 10, 5, 5);
  }

  // laneLineX 为中央/车道分隔虚线位置，默认 172（单车道对向道路）
  function drawEnvironment(ctx, simulation, C, laneLineX) {
    const lineX = laneLineX == null ? 172 : laneLineX;
    rect(ctx, '#42634d', 0, 0, C.WIDTH, C.HEIGHT);
    rect(ctx, '#adae99', 62, 0, 22, C.HEIGHT);
    rect(ctx, '#adae99', 294, 0, 22, C.HEIGHT);
    rect(ctx, '#d4ceb3', 79, 0, 5, C.HEIGHT);
    rect(ctx, '#d4ceb3', 294, 0, 5, C.HEIGHT);
    rect(ctx, '#3b484b', 84, 0, 210, C.HEIGHT);
    rect(ctx, '#334145', 88, 0, 2, C.HEIGHT);
    rect(ctx, '#334145', 288, 0, 2, C.HEIGHT);

    const scroll = (simulation.distance * C.PIXELS_PER_METER) % 32;
    for (let y = -32 + scroll; y < C.HEIGHT + 32; y += 32) {
      rect(ctx, '#8d9686', 62, y, 22, 2);
      rect(ctx, '#8d9686', 294, y, 22, 2);
      rect(ctx, '#526064', lineX, y, 4, 17);
    }

    const firstSegment = Math.floor((simulation.distance - 35) / 22);
    for (let i = 0; i < 9; i += 1) {
      const segment = firstSegment + i;
      const y = worldY(C, simulation, segment * 22);
      if (segment % 3 === 0) {
        rect(ctx, '#29443d', 0, y - 19, 32, 38);
        rect(ctx, '#36584b', 3, y - 16, 26, 30);
        rect(ctx, '#87a06e', 7, y - 10, 5, 5);
        rect(ctx, '#87a06e', 19, y + 2, 5, 5);
      } else {
        drawTree(ctx, 17, y, segment % 2);
      }
      if (segment % 2 === 0) drawTree(ctx, 343, y + 8, segment % 3);
      else {
        rect(ctx, '#203a39', 333, y - 12, 27, 34);
        rect(ctx, '#557360', 337, y - 8, 19, 24);
      }
    }
  }

  function drawCar(ctx, x, y, color, demo) {
    const w = 28;
    const h = 44;
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h / 2);
    rect(ctx, '#0d1c2455', left + 4, top + 4, w, h);
    rect(ctx, '#14232b', left - 3, top + 7, 3, 10);
    rect(ctx, '#14232b', left + w, top + 7, 3, 10);
    rect(ctx, '#14232b', left - 3, top + 28, 3, 10);
    rect(ctx, '#14232b', left + w, top + 28, 3, 10);
    rect(ctx, color || '#e7685b', left, top, w, h);
    rect(ctx, demo ? '#b8f4d4' : '#fa8a72', left + 3, top + 3, w - 6, 7);
    rect(ctx, '#294651', left + 3, top + 11, w - 6, 10);
    rect(ctx, '#80b9c1', left + 5, top + 12, w - 10, 4);
    rect(ctx, '#1c343e', left + 3, top + 22, w - 6, 3);
    rect(ctx, '#294651', left + 3, top + 26, w - 6, 8);
    rect(ctx, '#80b9c1', left + 5, top + 27, w - 10, 3);
    rect(ctx, demo ? '#4dbb8b' : '#c94c48', left + 3, top + 36, w - 6, 4);
    rect(ctx, '#fff2bd', left + 3, top, 6, 3);
    rect(ctx, '#fff2bd', left + w - 9, top, 6, 3);
    rect(ctx, '#c6383f', left + 3, top + h - 3, 6, 3);
    rect(ctx, '#c6383f', left + w - 9, top + h - 3, 6, 3);
  }

  function drawPedestrian(ctx, C, x, y, event, hidden, demo) {
    if (y < -20 || y > C.HEIGHT + 20) return;
    ctx.save();
    if (hidden) ctx.globalAlpha = 0.42;
    rect(ctx, '#12252c55', x + 2, y + 4, 5, 8);
    rect(ctx, '#26333a', x - 3, y + 5, 2, 5);
    rect(ctx, '#26333a', x + 2, y + 5, 2, 5);
    rect(ctx, demo ? '#80e0b1' : event.coatColor, x - 4, y - 2, 8, 8);
    rect(ctx, event.skinColor, x - 3, y - 7, 6, 5);
    rect(ctx, '#41362f', x - 3, y - 8, 6, 2);
    ctx.restore();
  }

  Game.Draw = {
    fillFittedText: fillFittedText,
    rect: rect,
    worldY: worldY,
    drawTree: drawTree,
    drawEnvironment: drawEnvironment,
    drawCar: drawCar,
    drawPedestrian: drawPedestrian
  };
})(typeof window !== 'undefined' ? window : globalThis);
