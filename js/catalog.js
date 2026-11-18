(function (root) {
  'use strict';

  const Game = root.BusGame = root.BusGame || {};

  Game.CATALOG = Object.freeze([
    {
      id: 'bus-ghost',
      episode: '01',
      status: 'playable',
      href: 'bus-ghost.html',
      art: 'bus-ghost',
      title: {
        zh: '公交车后的“鬼探头”',
        en: 'Bus Blind Spot'
      },
      description: {
        zh: '公交车挡住视线时，提前减速，为突然出现的行人留出安全余量。',
        en: 'Slow down before a bus blocks your view, leaving room for a pedestrian you cannot yet see.'
      }
    },
    {
      id: 'crosswalk-occlusion',
      episode: '02',
      status: 'playable',
      href: 'crosswalk.html',
      art: 'crosswalk',
      title: {
        zh: '多车道斑马线遮挡',
        en: 'Hidden Crosswalk'
      },
      description: {
        zh: '相邻车道的车辆可能挡住行人。识别视线死角，不要贸然超越正在减速的车辆。',
        en: 'A stopped vehicle can hide someone crossing. Read the blind spot and never rush past a slowing car.'
      }
    },
    {
      id: 'sudden-braking',
      episode: '03',
      status: 'hidden',
      href: 'braking.html',
      art: 'braking',
      title: {
        zh: '前车突然制动',
        en: 'Sudden Braking Ahead'
      },
      description: {
        zh: '依次经过城市、高速和雨天，按速度、天气与法规动态调整时距，提前松油并平稳制动。',
        en: 'Adapt your following gap through urban, expressway and wet conditions using speed, weather and legal references.'
      }
    },
    {
      id: 'parked-cars',
      episode: '04',
      status: 'playable',
      href: 'parked-cars.html',
      art: 'parked-cars',
      title: {
        zh: '路边车缝里的“鬼探头”',
        en: 'Hidden Between Parked Cars'
      },
      description: {
        zh: '连续违停车挡住多个车缝。观察脚步与阴影，提前减速并留出横向空间。',
        en: 'Scan gaps, feet and shadows along parked cars. Slow early and leave room before someone steps out.'
      }
    },
    {
      id: 'truck-inner-wheel',
      episode: '05',
      status: 'playable',
      href: 'truck-inner-wheel.html',
      art: 'truck-turn',
      title: {
        zh: '大货车右转与内轮差',
        en: 'Truck Right Turns & Offtracking'
      },
      description: {
        zh: '切换前视、右侧窗和右后视镜，让直行先行；按真实前后轮轨迹低速右转，理解内轮差。',
        en: 'Check forward, the right window and mirror. Yield to through traffic and follow real wheel paths through a right turn.'
      }
    },
    {
      id: 'blind-junction',
      episode: '06',
      status: 'playable',
      href: 'blind-junction.html',
      art: 'blind-junction',
      title: {
        zh: '路口与巷口的视线盲区',
        en: 'Blind Junctions'
      },
      description: {
        zh: '围墙、建筑和绿化会遮住左右巷口。按可见停车余量提前控速，等行人或电动车清空后再通过。',
        en: 'Walls, buildings and hedges can hide either side road. Match speed to your visible stopping distance and let pedestrians and e-bikes clear the junction.'
      }
    },
    {
      id: 'crosswalk-turnback',
      episode: '07',
      status: 'playable',
      href: 'crosswalk-turnback.html',
      art: 'crosswalk-turnback',
      title: {
        zh: '人行横道上的突然加速与折返',
        en: 'Crosswalk Surges & Turnbacks'
      },
      description: {
        zh: '行人可能突然加速或中途折返。提前停车让行，等斑马线完全清空后再起步。',
        en: 'Pedestrians may speed up or turn back. Stop early and move off only when the crosswalk is fully clear.'
      }
    },
    {
      id: 'dooring',
      episode: '08',
      status: 'playable',
      href: 'dooring.html',
      art: 'door-open',
      title: {
        zh: '停靠车辆突然开门（“开门杀”）',
        en: 'Parked-Car Dooring'
      },
      description: {
        zh: '分别从乘客、骑行者和后方驾驶员视角，练习观察后再开门、避开汽车车门区和保持安全空间。',
        en: 'Replay one dooring event as passenger, cyclist and driver. Look before opening, avoid the door zone and leave room.'
      }
    },
    {
      id: 'reversing-blind-spot',
      episode: '09',
      status: 'playable',
      href: 'reversing-blind-spot.html',
      art: 'reversing-blind-spot',
      title: {
        zh: '倒车时的车后盲区',
        en: 'Reversing Blind Spots'
      },
      description: {
        zh: '绕车检查不能替代持续观察。切换后视、影像和后视镜，低速倒车，无法确认时立即停车。',
        en: 'A walk-around is only the start. Scan behind and to both sides, reverse slowly, and stop whenever you cannot confirm it is clear.'
      }
    },
    {
      id: 'nonmotor-mix',
      episode: '10',
      status: 'playable',
      href: 'nonmotor-mix.html',
      art: 'nonmotor-mix',
      title: {
        zh: '非机动车逆行与突然变道',
        en: 'Wrong-Way Riders & Sudden Swerves'
      },
      description: {
        zh: '识别逆行、绕障变道和路侧斜穿。提前控速，按真实运动方向预留横向与纵向空间。',
        en: 'Read wrong-way riders, obstacle swerves and diagonal entries. Slow early and leave room for their actual path.'
      }
    },
    {
      id: 'red-light-runner',
      episode: '11',
      status: 'hidden',
      href: 'red-light-runner.html',
      art: 'red-light-runner',
      title: {
        zh: '绿灯路口与闯红灯车辆',
        en: 'Green Lights & Red-Light Runners'
      },
      description: {
        zh: '绿灯是通行权，不是安全保证。进入路口前扫视左右，识别高速闯灯车，等全部清空再通过。',
        en: 'Green means right of way, not guaranteed safety. Scan both ways, read fast red-light runners and proceed only when clear.'
      }
    },
    {
      id: 'unsignalized-cross-traffic',
      episode: '12',
      status: 'hidden',
      href: 'unsignalized-cross-traffic.html',
      art: 'cross-traffic',
      title: {
        zh: '无信号灯路口的交叉来车',
        en: 'Unsignalized Cross Traffic'
      },
      description: {
        zh: '建筑与植被遮挡左右来车。真正停车瞭望，按当地规则让行，确认对方停稳或完全清空后再通过。',
        en: 'Buildings and hedges hide cross traffic. Stop and look, follow the local yield rule, and proceed only after a confirmed yield or a complete clear.'
      }
    },
    {
      id: 'yellow-light-decision',
      episode: '13',
      status: 'hidden',
      href: 'yellow-light-decision.html',
      art: 'yellow-light-decision',
      title: {
        zh: '黄灯亮起',
        en: 'The Yellow Light'
      },
      description: {
        zh: '看清停止线与后路，根据实时余量选择停车或平稳通过。',
        en: 'Read the stop line and following traffic, then stop or proceed smoothly according to the real margin.'
      }
    },
    {
      id: 'sudden-cut-in',
      episode: '14',
      status: 'hidden',
      href: 'sudden-cut-in.html',
      art: 'sudden-cut-in',
      title: {
        zh: '近距加塞与空间恢复',
        en: 'Sudden Cut-Ins & Space Recovery'
      },
      description: {
        zh: '识别并线前兆，不加速封堵；提前松油、平稳让速，重新建立动态安全空间。',
        en: 'Read merge cues without accelerating to block. Ease off, yield smoothly and restore a dynamic safety margin.'
      }
    },
    {
      id: 'multi-car-pileup',
      episode: '15',
      status: 'hidden',
      href: 'multi-car-pileup.html',
      art: 'multi-car-pileup',
      title: {
        zh: '前车急刹与多车连环追尾',
        en: 'Chain-Reaction Braking'
      },
      description: {
        zh: '观察前车前方，保持随速度和天气变化的动态车距，避免多车连锁追尾。',
        en: 'Look beyond the car ahead and keep a dynamic gap matched to speed and weather to avoid chain-reaction pileups.'
      }
    },
    {
      id: 'revealed-stopped-vehicle',
      episode: '16',
      status: 'hidden',
      href: 'revealed-stopped-vehicle.html',
      art: 'revealed-stopped-vehicle',
      title: {
        zh: '前车绕开之后，别跟着冲',
        en: 'Revealed Stopped Vehicle'
      },
      description: {
        zh: '前车绕行可能只是正常变道，也可能正在躲避静止车。先控速、留余量，看清本车道后停车或继续。',
        en: 'A car moving aside may reveal a stopped vehicle. Slow early, preserve a stopping margin, then stop or proceed once your lane is clear.'
      }
    },
    {
      id: 'obscured-signal-intersection',
      episode: '17',
      status: 'hidden',
      href: 'obscured-signal-intersection.html',
      art: 'obscured-signal-intersection',
      title: {
        zh: '被大型车辆遮挡的信号灯与路口',
        en: 'Obscured Signals & Intersections'
      },
      description: {
        zh: '大型车挡住信号与横向危险时，拉开距离恢复自己的视野，独立确认后再通过。',
        en: 'When a large vehicle hides the signal and cross traffic, open a gap, recover your own view and confirm before proceeding.'
      }
    },
    {
      id: 'lane-change-blind-spot',
      episode: '18',
      status: 'hidden',
      href: 'lane-change-blind-spot.html',
      art: 'lane-change-blind-spot',
      title: {
        zh: '变道时目标车道盲区内有车',
        en: 'Lane-Change Blind Spots'
      },
      description: {
        zh: '变道前用后视镜和回头观察确认目标车道，盲区有车就保持本车道，等安全窗口再平稳变道。',
        en: 'Check the mirror and the rear blind spot before changing lanes. If the target lane is occupied, stay in lane and wait for a safe window.'
      }
    },
    {
      id: 'large-vehicle-blind-zones',
      episode: '19',
      status: 'hidden',
      href: 'large-vehicle-blind-zones.html',
      art: 'large-vehicle-blind-zones',
      title: {
        zh: '大型车辆周围的多处盲区',
        en: 'Large-Vehicle Blind Zones'
      },
      description: {
        zh: '从大车驾驶员的真实视野判断车头、车尾与两侧盲区，避开大车的转向和倒车扫掠范围。',
        en: 'Judge the front, rear and side blind zones from the truck driver’s real field of view, and stay clear of its turning and reversing sweep.'
      }
    }
  ]);
})(typeof window !== 'undefined' ? window : globalThis);
