import { createSearcher } from '../engine'

interface DeviceSearchItem {
  device_id: string
  name: string
  type: string
  state: string
  trust: string
  route?: string
}

interface TransferSearchItem {
  name: string
  deviceName: string
  kind: string
  direction: string
  itemKind: string
}

export const createDeviceSearcher = <T extends DeviceSearchItem>() => createSearcher<T>([
  { key: 'name', get: (d) => d.name, weight: 2, aliases: ['设备', '名称', 'device'] },
  { key: 'id', get: (d) => d.device_id, aliases: ['编号'] },
  { key: 'type', get: (d) => d.type, aliases: ['类型'] },
  { key: 'state', get: (d) => d.state, aliases: ['状态', 'status'] },
  { key: 'trust', get: (d) => d.trust, aliases: ['信任'] },
  { key: 'route', get: (d) => d.route, aliases: ['链路'] },
])

export const createTransferSearcher = <T extends TransferSearchItem>() => createSearcher<T>([
  { key: 'file', get: (r) => r.name, weight: 2, aliases: ['文件', 'name'] },
  { key: 'device', get: (r) => r.deviceName, weight: 1.5, aliases: ['设备', '来源'] },
  { key: 'status', get: (r) => r.kind, aliases: ['状态'] },
  { key: 'direction', get: (r) => r.direction, aliases: ['方向'] },
  { key: 'type', get: (r) => r.itemKind, aliases: ['类型'] },
])
