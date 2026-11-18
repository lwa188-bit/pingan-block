(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};
  const C = Game.C;
  const t = Game.I18N.t;
  const Draw = Game.Draw;

  const fillFittedText = Draw.fillFittedText;
  const rect = Draw.rect;
  const drawCar = Draw.drawCar;

  function worldY(simulation, worldPosition) {
    return Draw.worldY(C, simulation, worldPosition);
  }

  function drawEnvironment(ctx, simulation) {
    Draw.drawEnvironment(ctx, simulation, C);
  }

  function drawPedestrian(ctx, x, y, event, hidden, demo) {
    Draw.drawPedestrian(ctx, C, x, y, event, hidden, demo);
  }

  function drawRiskZone(ctx, simulation, event) {
    const top = worldY(simulation, event.busPosition + C.RISK_END);
    const bottom = worldY(simulation, event.busPosition - C.RISK_START);
    if (bottom < 0 || top > C.HEIGHT) return;
    const y = Math.max(0, top);
    const height = Math.min(C.HEIGHT, bottom) - y;
    ctx.save();
    ctx.globalAlpha = 0.15;
    rect(ctx, '#f4c75b', 180, y, 112, height);
    ctx.globalAlpha = 0.4;
    for (let stripe = y - 120; stripe < y + height + 120; stripe += 18) {
      ctx.fillStyle = '#f4cf70';
      ctx.beginPath();
      ctx.moveTo(180, stripe);
      ctx.lineTo(188, stripe);
      ctx.lineTo(292, stripe + 104);
      ctx.lineTo(292, stripe + 112);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    const markerY = worldY(simulation, event.busPosition - C.SLOW_CHECK);
    if (markerY > 100 && markerY < C.HEIGHT - 20) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#ffe292';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(180, markerY);
      ctx.lineTo(292, markerY);
      ctx.stroke();
      ctx.restore();
      const markerText = t('canvas.slowMarker');
      ctx.font = '8px sans-serif';
      const markerWidth = Math.min(104, Math.max(76, Math.ceil(ctx.measureText(markerText).width) + 10));
      rect(ctx, '#142630dd', 182, markerY - 14, markerWidth, 12);
      ctx.fillStyle = '#ffe6a4';
      fillFittedText(ctx, markerText, 187, markerY - 5, markerWidth - 10, 8, 'sans-serif');
    }
  }

  function drawBus(ctx, x, frontY, demo) {
    const width = 40;
    const length = 96;
    const left = Math.round(x - width / 2);
    const top = Math.round(frontY);
    if (top > C.HEIGHT + 20 || top + length < -20) return;

    rect(ctx, '#14252b55', left + 5, top + 5, width, length);
    rect(ctx, demo ? '#73bda4' : '#e8b94f', left, top, width, length);
    rect(ctx, demo ? '#9de2c4' : '#ffd66e', left + 2, top + 2, width - 4, 6);
    rect(ctx, '#253c46', left + 2, top + 8, width - 4, 10);
    rect(ctx, '#78a4ae', left + 4, top + 9, width - 8, 4);
    for (let y = top + 22; y < top + length - 11; y += 12) {
      rect(ctx, '#29434d', left + 2, y, 3, 8);
      rect(ctx, '#29434d', left + width - 5, y, 3, 8);
    }
    rect(ctx, '#cc9338', left + 3, top + length - 8, width - 6, 4);
    rect(ctx, '#17292f', left - 2, top + 9, 3, 10);
    rect(ctx, '#17292f', left + width - 1, top + 9, 3, 10);
    rect(ctx, '#17292f', left - 2, top + length - 15, 3, 10);
    rect(ctx, '#17292f', left + width - 1, top + length - 15, 3, 10);
    rect(ctx, '#fff1b8', left + 2, top + 1, 3, 3);
    rect(ctx, '#fff1b8', left + width - 5, top + 1, 3, 3);
  }

  function drawBlindSpot(ctx, simulation, event, fullPath) {
    const frontY = worldY(simulation, event.busPosition);
    const busWidth = 40;
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(C.BUS_X - busWidth / 2, frontY + 5);
    ctx.lineTo(178, frontY - 28);
    ctx.lineTo(178, frontY + 76);
    ctx.lineTo(C.BUS_X - busWidth / 2, frontY + 55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (fullPath && event.pedestrian.active) {
      const pedestrianY = worldY(simulation, event.busPosition + 1.8);
      ctx.save();
      ctx.strokeStyle = '#fff0a8';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(C.BUS_X, pedestrianY);
      ctx.lineTo(event.pedestrian.x, pedestrianY);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawStopGuide(ctx, simulation, event) {
    if (!event || !event.occupied || !event.pedestrian.visible || event.pedestrian.waiting) return;
    const pedestrianY = worldY(simulation, event.busPosition + 1.8);
    const distance = event.busPosition + 1.8 - simulation.distance;
    if (distance < -2 || distance > 20) return;
    ctx.save();
    ctx.strokeStyle = '#ffe189';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(simulation.x - 17, C.CAR_Y - 23);
    ctx.lineTo(simulation.x - 17, pedestrianY + 8);
    ctx.moveTo(simulation.x + 17, C.CAR_Y - 23);
    ctx.lineTo(simulation.x + 17, pedestrianY + 8);
    ctx.stroke();
    ctx.restore();
  }

  function drawFreeze(ctx, simulation) {
    rect(ctx, '#13263355', 0, 0, C.WIDTH, C.HEIGHT);
    const event = simulation.events[simulation.freezeInfo.eventId];
    drawBlindSpot(ctx, simulation, event, true);
    const x = simulation.x + 21;
    const y = C.CAR_Y - 30;
    rect(ctx, '#fff0b0', x, y, 22, 24);
    rect(ctx, '#3b2a0e', x + 9, y + 4, 4, 10);
    rect(ctx, '#3b2a0e', x + 9, y + 17, 4, 4);
  }

  function drawDemo(ctx, simulation) {
    const demo = simulation.demo;
    const event = simulation.events[demo.eventId];
    const demoView = { distance: demo.distance };
    drawEnvironment(ctx, demoView);
    drawRiskZone(ctx, demoView, event);
    drawBlindSpot(ctx, demoView, event, true);
    drawBus(ctx, C.BUS_X, worldY(demoView, event.busPosition), true);
    if (demo.pedestrianActive) {
      drawPedestrian(ctx, demo.pedestrianX, worldY(demoView, event.busPosition + 1.8), event, false, true);
    }
    drawCar(ctx, demo.x, C.CAR_Y, '#65d6a1', true);
    ctx.save();
    ctx.strokeStyle = '#a6f0c8';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(demo.x, C.CAR_Y + 24);
    ctx.lineTo(demo.x, C.CAR_Y + 55);
    ctx.stroke();
    ctx.restore();
    rect(ctx, '#0e202ddd', 212, 552, 126, 47);
    ctx.fillStyle = '#a6f0c8';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(Math.round(demo.speed) + ' km/h', 220, 575);
    ctx.fillStyle = '#d4e3db';
    const demoText = t(demo.speed < 1 ? 'canvas.wait' : 'canvas.principles');
    fillFittedText(ctx, demoText, 220, 590, 110, 9, 'sans-serif');
  }

  function render(ctx, simulation) {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, C.WIDTH, C.HEIGHT);
    if (simulation.status === 'demonstrating' && simulation.demo) {
      drawDemo(ctx, simulation);
      return;
    }

    drawEnvironment(ctx, simulation);
    simulation.events.forEach(function (event) {
      drawRiskZone(ctx, simulation, event);
    });
    simulation.events.forEach(function (event) {
      const frontY = worldY(simulation, event.busPosition);
      if (simulation.status === 'frozen' && simulation.freezeInfo.eventId === event.id) {
        drawBlindSpot(ctx, simulation, event, true);
      }
      if (event.occupied && event.pedestrian.active) {
        const pedestrianY = worldY(simulation, event.busPosition + 1.8);
        if (event.pedestrian.visible || simulation.status === 'frozen') {
          drawPedestrian(ctx, event.pedestrian.x, pedestrianY, event, false);
        }
      }
      drawBus(ctx, C.BUS_X, frontY, false);
    });
    drawStopGuide(ctx, simulation, simulation.currentEvent);
    drawCar(ctx, simulation.x, C.CAR_Y, '#e7685b', false);
    if (simulation.status === 'frozen' && simulation.freezeInfo) drawFreeze(ctx, simulation);
  }

  Game.Renderer = { render: render, worldY: worldY };
})(typeof window !== 'undefined' ? window : globalThis);
