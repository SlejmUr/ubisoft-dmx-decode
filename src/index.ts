/* eslint-disable no-console */
/* eslint-disable no-underscore-dangle */
import protobuf from 'protobufjs';
import glob from 'glob';
import { readFileSync, outputJSONSync } from 'fs-extra';
import jsonHandler from './util/json-dupe-parse'; // Handles duplicate JSON keys
import * as demux from './generated/proto/proto_demux/demux';

const DEMUX_HOST = 'dmx.upc.ubisoft.com';

const protoFiles = glob.sync('proto/**/*.proto');
console.log(`Loaded ${protoFiles.length} protos`);
const packageDefinition = protobuf.loadSync(protoFiles);

const demuxSchema = packageDefinition.lookup('mg.protocol.demux') as protobuf.Namespace;

const serviceMap: Record<string, protobuf.Namespace> = {
  utility_service: packageDefinition.lookup('mg.protocol.utility') as protobuf.Namespace,
  ownership_service: packageDefinition.lookup('mg.protocol.ownership') as protobuf.Namespace,
  denuvo_service: packageDefinition.lookup('mg.protocol.denuvo_service') as protobuf.Namespace,
  store_service: packageDefinition.lookup('mg.protocol.store') as protobuf.Namespace,
  friends_service: packageDefinition.lookup('mg.protocol.friends') as protobuf.Namespace,
  playtime_service: packageDefinition.lookup('mg.playtime') as protobuf.Namespace,
  party_service: packageDefinition.lookup('mg.protocol.party') as protobuf.Namespace,
  download_service: packageDefinition.lookup('mg.protocol.download_service') as protobuf.Namespace,
  client_configuration_service: packageDefinition.lookup(
    'mg.protocol.client_configuration'
  ) as protobuf.Namespace,
};

interface TLSPayload {
  data: Buffer;
  frame: number;
  direction: 'Upstream' | 'Downstream';
}

const getTLSPayload = (wsPacket: any): TLSPayload[] | null => {
  const layers = wsPacket._source?.layers;
  if (layers?.tls && 'Ignored Unknown Record' in layers.tls) {
    console.warn('Warning: Ignored Unknown Record');
    return null;
  }
  if (layers?.tls) {
    const tlsData = layers.tls['tls.record'];
    const data: string = tlsData['tls.app_data'];
    if (data === undefined) return null;
  } else {
    return null;
  }

  const frame = parseInt(layers.frame['frame.number'], 10);
  console.warn(wsPacket._source?.layers?.ip['ip.dst_host'] + " " + wsPacket._source?.layers?.ip['ip.src_host']);
  let direction: 'Upstream' | 'Downstream' | null = null;
  if (wsPacket._source?.layers?.ip['ip.dst_host'] === DEMUX_HOST) {
    console.warn('Upstream');
    direction = 'Upstream';
  }
  if (wsPacket._source?.layers?.ip['ip.src_host'] === DEMUX_HOST) {
    console.warn('Downstream');
    direction = 'Downstream';
  }
  if (!direction) return null;

  const dataKeys = Object.keys(layers).filter((key) => key.match(/tls\d*/));
  //console.warn(dataKeys);
  const payloads = dataKeys
    .map((key) => {
      const currentData = layers[key]['tls.record']['tls.app_data'];
      if (!currentData) return null;
      return {
        frame,
        direction,
        data: Buffer.from(currentData.replace(/:/g, ''), 'hex'),
      };
    })
    .filter((p): p is TLSPayload => p !== null);
  console.warn(payloads);
  return payloads;
};

// TODO SOLVE THIS PIECE OF SHIT
const payloadJoiner = (payloads: TLSPayload[]): TLSPayload[] => {
  const joinedPayloads: TLSPayload[] = [];
  let currentPayload: Buffer | null = null;
  let currentPayloadLength: number | null = null;
  payloads.forEach((payload) => {
    const { data } = payload;
    //console.warn(data);
    console.warn("DL: " + data.length);
    if (currentPayload === null) {
      console.warn(data);
      const length = data.readUInt32BE();
      console.warn(length);
      const dataSeg = data.subarray(4);
      console.warn(dataSeg.length);
      if (dataSeg.length === currentPayloadLength) {
        joinedPayloads.push({ ...payload, data: dataSeg });
      } else {
        currentPayload = dataSeg;
        currentPayloadLength = data.length;
      }
    } else {
      const dataSeg = Buffer.concat([currentPayload, data]);
      //console.warn(dataSeg);
      if (dataSeg.length === currentPayloadLength) {
        joinedPayloads.push({ ...payload, data: dataSeg });
        console.warn("IDK " + currentPayloadLength);
        currentPayload = null;
        currentPayloadLength = null;
        console.warn("true");
      } else {
        currentPayload = dataSeg;
        console.warn("IDK2 " + currentPayloadLength);
      }
    }
  });
  console.warn(joinedPayloads);
  return joinedPayloads;
};

const decodeRequests = (payloads: TLSPayload[]): any[] => {
  const openServiceRequests = new Map<number, string>();
  const openConnectionRequests = new Map<number, string>();
  const openConnections = new Map<number, string>();
  return [];
  // TODO SOLVE THIS , BUT PROBABLY IF THE TLS PAYLOAD WILL BE GOOD THIS IS CAN BE IGNORED
  const decodedDemux = payloads.map((payload) => {
    const schema = demuxSchema.lookupType(payload.direction);
    const body = schema.decode(payload.data) as
      | (protobuf.Message & demux.Upstream)
      | (protobuf.Message & demux.Downstream);

    // Service requests/responses
    if ('request' in body && body.request?.serviceRequest) {
      const { requestId } = body.request;
      const { data, service } = body.request.serviceRequest;
      const serviceSchema = serviceMap[service];
      if (!serviceSchema) throw new Error(`Missing service: ${service}`);
      const dataType = serviceSchema.lookupType(payload.direction);
      const decodedData = dataType.decode(data) as never;
      openServiceRequests.set(requestId, service);
      const updatedBody = body.toJSON();
      updatedBody.request.serviceRequest.data = decodedData;
      return updatedBody;
    }
    if ('response' in body && body.response?.serviceRsp) {
      const { requestId } = body.response;
      const { data } = body.response.serviceRsp;
      const serviceName = openServiceRequests.get(requestId) as string;
      const serviceSchema = serviceMap[serviceName];
      const dataType = serviceSchema.lookupType(payload.direction);
      const decodedData = dataType.decode(data) as never;
      openServiceRequests.delete(requestId);
      const updatedBody = body.toJSON();
      updatedBody.response.serviceRsp.data = decodedData;
      return updatedBody;
    }

    // Connection requests/responses
    if ('request' in body && body.request?.openConnectionReq) {
      const { requestId } = body.request;
      const { serviceName } = body.request.openConnectionReq;
      openConnectionRequests.set(requestId, serviceName);
    }
    if ('response' in body && body.response?.openConnectionRsp) {
      const { requestId } = body.response;
      const { connectionId } = body.response.openConnectionRsp;
      const serviceName = openConnectionRequests.get(requestId) as string;
      openConnections.set(connectionId, serviceName);
      openConnectionRequests.delete(requestId);
    }

    // Connection pushes/closed
    if ('push' in body && body.push?.data) {
      const { connectionId, data } = body.push.data;
      const serviceName = openConnections.get(connectionId) as string;
      const serviceSchema = serviceMap[serviceName];
      if (!serviceSchema) throw new Error(`Missing service: ${serviceName}`);
      const dataType = serviceSchema.lookupType(payload.direction);
      const trimmedPush = data.subarray(4); // First 4 bytes are length
      const decodedData = dataType.decode(trimmedPush) as never;
      const updatedBody = body.toJSON();
      updatedBody.push.data.data = decodedData;
      return updatedBody;
    }
    if ('push' in body && body.push?.connectionClosed) {
      const { connectionId } = body.push.connectionClosed;
      openConnections.delete(connectionId);
    }
    return body.toJSON();
  });
  return decodedDemux;
};

const main = () => {
  const wsJson: any[] = jsonHandler.parse(readFileSync('dmx-upc.json', 'utf-8'), 'increment');
  outputJSONSync('deduped-dmx-upc.json', wsJson, { spaces: 2 });
  const payloads = wsJson
    .map(getTLSPayload)
    .filter((p): p is TLSPayload[] => p !== null)
    .flat();
  console.log(`${payloads.length} payloads found`);
  const joinedPayloads = payloadJoiner(payloads);
  outputJSONSync('tls-payloads_.json', payloads, { spaces: 2 }); //THIS ACTUALLY GIVE BACK SOMETHING!!
  outputJSONSync('tls-payloads.json', joinedPayloads, { spaces: 2 });
  const decodedDemuxes = decodeRequests(joinedPayloads);
  const decodedDemuxes2 = decodeRequests(payloads);
  console.log(`Generated ${decodedDemuxes.length} responses`);
  console.log(`Generated ${decodedDemuxes2.length} responses`);
  outputJSONSync('decodes.json', decodedDemuxes, {
    spaces: 2,
  });
    outputJSONSync('decodes2.json', decodedDemuxes2, {
    spaces: 2,
  });
};

main();
