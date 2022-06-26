import net from 'net';
import { EventEmitter } from 'events';

import LoadBalancer, { ALGORITHM } from './LoadBalancer';
import shadowChecker from './helpers/shadow-checker';
import { Target } from './LoadBalancer/types';
import { info } from '../logs';
import { i18n } from '../electron';

const udpf = require('node-udp-forwarder');
const TCPWrap = (process as any).binding('tcp_wrap');
const { TCP } = TCPWrap;

export interface SocketTransferOptions {
  port?: number;
  address?: string;
  bind?: string;
  strategy?: ALGORITHM;
  targets: Target[];
  heartbeat?: number | number[];
};

type UdpConf = {[key: string]: any[]};

export class SocketTransfer extends EventEmitter {
  public bytesTransfer = 0;
  public speed = '';
  private port: number;
  private address: string;
  private bind: string;
  private targets: Target[];
  private timer: NodeJS.Timeout | null;
  private udpConf: UdpConf;
  private server: net.Server;
  private udpServers: any[];
  private lb: LoadBalancer;
  private strategy: ALGORITHM;
  private heartbeat: number[];

  constructor(options: SocketTransferOptions) {
    super();
    this.heartbeat = ([] as number[]).concat(options.heartbeat ?? 60e3*5);
    this.port = options.port || 1080;
    this.address = options.address ?? '127.0.0.1';
    this.bind = options.bind ?? '0.0.0.0';
    this.udpConf = {
      bind4: ["127.0.0.1", this.port],
      bind6: ["::1", this.port],
      server: ['114.114.114.114', 53]
    };
    this.server = this.init();
    this.udpServers = this.forwardUDP(this.udpConf);
    this.timer = null;
    this.server.on('error', this.onError);
    this.targets = options.targets;
    this.strategy = options.strategy || ALGORITHM.POLLING;
    this.lb = new LoadBalancer({
      algorithm: this.strategy,
      targets: this.targets,
    });
    this.setHealthCheckTimer();
  }

  private init() {
    return net.createServer((c) => {
      const target = this.lb.pickOne();
      console.log('pick target -> ', target?.id);

      if (!target || !target.id) {
        this.onLoadBalancerError(new Error('no available target!'));
        return c.end('socket transfer not ready!');
      }

      c.on('end', () => {
        this.bytesTransfer += (c.bytesRead + c.bytesWritten);
      });
      c.on('error', this.onLocalError);

      const remote = net.createConnection({ port: +target.id, host: this.bind }, () => {
        c.pipe(remote);
        remote.pipe(c);
      });

      remote.on('error', (error) => this.onRemoteError(error, +target.id));
    });
  }

  private forwardUDP(conf: UdpConf) {

    const optionsV4 = {
      protocol: 'udp4',
      forwarderPort: conf.bind4[1],
      forwarderAddress: conf.bind4[0],
      created: () => {
        console.log(`UDP4 listening on ${udpV4.address}:${udpV4.port}`);
        console.log(`forwarding from ${udpV4.forwarderAddress}:${udpV4.forwarderPort}`);
      }
    };
    const optionsV6 = {
      protocol: 'udp6',
      forwarderPort: conf.bind6[1],
      forwarderAddress: conf.bind6[0],
      created: () => {
        console.log(`UDP6 listening on ${udpV6.address}:${udpV6.port}`);
        console.log(`forwarding from ${udpV6.forwarderAddress}:${udpV6.forwarderPort}`);
      }
    };

    const udpV4 = udpf.create(conf.server[1], conf.server[0], optionsV4);
    const udpV6 = udpf.create(conf.server[1], conf.server[0], optionsV6);

    return [udpV4, udpV6];
  }

  private setHealthCheckTimer = (immediate: boolean = false) => {
    if (this.heartbeat.length > 1) {
      immediate && this.healthCheck();
      this.timer = setTimeout(() => {
        this.setHealthCheckTimer(true);
      }, this.heartbeat.shift() as number);
    } else {
      immediate && this.healthCheck();
      this.timer = setInterval(this.healthCheck, this.heartbeat[0]);
    }
  }

  private onLoadBalancerError = (error: Error) => {
    console.error('loadbalancer-error:', error);
    this.emit('error:loadbalancer', { error });
  }

  private onLocalError = (error: Error) => {
    console.error('local-error:', error);
    // this.emit('error:server:local', { error });
  }

  private onRemoteError = (error: Error, port: number) => {
    console.error('remote-error:', error, port);
    // this.emit('error:server:remote', {
    //   error,
    //   port
    // });
  }

  private doCheckWorks = async (targets: Target[]): Promise<Target[]> => {
    const failed: Target[] = [];
    const results = await Promise.all(targets.map(target => shadowChecker(this.address, target.id as number)));
    info.bold('>> healthCheck results: ', results);
    results.forEach((pass, i) => {
      if (!pass) {
        failed.push(targets[i]);
      }
    });

    return failed;
  };

  private healthCheck = () => {
    if (this.targets.length === 0) return;

    this.doCheckWorks(this.targets)
      .then((pending = []) => {
        if (!pending.length) return pending;
        return this.doCheckWorks(pending);
      })
      .then(failed => {
        if (failed.length) {
          this.emit('health:check:failed', failed);
        }
      })
      .catch(error => {
        console.error('healthCheck:', error);
        this.emit('error:health:heck', { error });
      });
  }

  private onError = (error: Error) => {
    console.error('server-error:', error);
    this.emit('error:socket:transfer', { error });
  }

  public stopHealthCheck() {
    this.timer && clearInterval(this.timer);
  }

  public listen = (port?: number) => {
    if (port) this.port = port;
    const socket = new TCP(TCPWrap.constants.SERVER); // or .SOCKET

    socket.bind(this.address, this.port);

    return new Promise(((resolve, reject) => {
      this.once('error:socket:transfer', ({ error }) => {
        if (error && error.code === 'EADDRINUSE') {
          reject(`${i18n.__('port_already_used')}${this.port}`);
        } else {
          reject(error ?? new Error(i18n.__('failed_to_start_socket_transfer')));
        }
      });
    
      this.server.listen(socket, () => {
        resolve(port);
        info.bold('>> SocketTransfer listening on port: ', this.port);
      });
    }));
  }

  public unlisten = async () => {
    return new Promise<Error | void>(resolve => {
      if (!this.server) return resolve();
      try {
        this.udpServers[0].end();
        this.udpServers[1].end();
      } catch (error) {
        console.log(error);
      }
      this.server.close((error) => {
        resolve(error);
      });
      setTimeout(() => {
        resolve(new Error('unlisten timeout'));
      }, 500);
    });
  }

  public stop = async () => {
    this.stopHealthCheck();
    await this.unlisten();
  }

  public pushTargets = (targets: Target[]) => {
    this.targets.push(...targets);
    this.lb.setTargets(this.targets);
  }

  public setHeartBeat = (heartbeat: (number[] | number)) => {
    const value = ([] as number[]).concat(heartbeat);
    if (!value.length) return;

    value.forEach(val => {
      if (typeof val !== 'number' || val < 5) {
        throw new Error('SocketTransfer: heartbeat must be an positive number and no less that 5(seconds).');
      }
    });
    this.heartbeat = value; // 5min
    this.timer && clearInterval(this.timer);
    this.setHealthCheckTimer();
  }

  public setTargets = (targets: Target[]) => {
    this.targets = targets;
    this.lb.setTargets(targets);
  }

  public setTargetsWithFilter = (filter: (targets: Target) => boolean) => {
    this.targets = this.targets.filter(filter);
    this.setTargets(this.targets)
  }

  public getTargets = () => {
    return [...this.targets];
  }
}
