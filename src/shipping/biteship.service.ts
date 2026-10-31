import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BiteshipItem {
  name: string;
  value: number;
  weight: number;
  quantity: number;
}

export interface CourierRate {
  courier_code: string;
  courier_service_code: string;
  courier_name: string;
  courier_service_name: string;
  description: string;
  duration: string;
  price: number;
}

export interface BiteshipArea {
  id: string;
  name: string;
  postal_code: number;
  /** City / regency */
  administrative_division_level_2_name?: string;
  /** Kecamatan */
  administrative_division_level_3_name?: string;
}

/** Shared fields of the order.status / order.waybill_id / order.price events. */
export interface BiteshipWebhook {
  order_id?: string;
  status?: string;
  courier_waybill_id?: string | null;
  courier_tracking_id?: string | null;
  courier_link?: string | null;
}

export interface ShipmentContact {
  name: string;
  phone: string;
  email: string;
  address: string;
  areaId?: string | null;
  postalCode: string;
  note?: string | null;
}

export interface ShipmentOrigin {
  contactName: string;
  phone: string;
  address: string;
  postalCode: string;
}

/** Indonesia only: international orders ship manually and never reach this service. */
@Injectable()
export class BiteshipService {
  private readonly logger = new Logger(BiteshipService.name);

  constructor(private readonly config: ConfigService) {}

  async searchAreas(input: string): Promise<BiteshipArea[]> {
    const params = new URLSearchParams({ countries: 'ID', input, type: 'single' });
    const res = await this.request<{ areas: BiteshipArea[] }>('GET', `/v1/maps/areas?${params}`);
    return res.areas ?? [];
  }

  async rates(
    origin: Pick<ShipmentOrigin, 'postalCode'>,
    destination: { areaId?: string; postalCode: string },
    items: BiteshipItem[],
  ) {
    const res = await this.request<{ pricing: CourierRate[] }>('POST', '/v1/rates/couriers', {
      origin_postal_code: Number(origin.postalCode),
      ...(destination.areaId && { destination_area_id: destination.areaId }),
      destination_postal_code: Number(destination.postalCode),
      couriers: this.config.get('BITESHIP_COURIERS') ?? 'jne,jnt,sicepat',
      items,
    });
    return (res.pricing ?? []).map((p) => ({
      courier_code: p.courier_code,
      courier_service_code: p.courier_service_code,
      courier_name: p.courier_name,
      courier_service_name: p.courier_service_name,
      description: p.description,
      duration: p.duration,
      price: p.price,
    }));
  }

  /** Books the courier pickup; returns Biteship order id, waybill and tracking details. */
  async createOrder(params: {
    referenceId: string;
    origin: ShipmentOrigin;
    destination: ShipmentContact;
    courierCode: string;
    courierService: string;
    items: BiteshipItem[];
  }) {
    const { origin, destination } = params;
    const res = await this.request<{
      id: string;
      courier: { waybill_id: string | null; tracking_id: string | null; link: string | null };
    }>('POST', '/v1/orders', {
      reference_id: params.referenceId,
      shipper_contact_name: origin.contactName,
      shipper_contact_phone: origin.phone,
      origin_contact_name: origin.contactName,
      origin_contact_phone: origin.phone,
      origin_address: origin.address,
      origin_postal_code: Number(origin.postalCode),
      destination_contact_name: destination.name,
      destination_contact_phone: destination.phone,
      destination_contact_email: destination.email,
      destination_address: destination.address,
      ...(destination.areaId && { destination_area_id: destination.areaId }),
      destination_postal_code: Number(destination.postalCode),
      destination_note: destination.note ?? undefined,
      courier_company: params.courierCode,
      courier_type: params.courierService,
      delivery_type: 'now',
      items: params.items,
    });
    return {
      biteshipId: res.id,
      waybill: res.courier?.waybill_id ?? null,
      trackingId: res.courier?.tracking_id ?? null,
      trackingUrl: res.courier?.link ?? null,
    };
  }

  async tracking(trackingId: string) {
    return this.request<{
      status: string;
      waybill_id: string;
      courier: { company: string; driver_name?: string; driver_phone?: string };
      history: { note: string; status: string; updated_at: string }[];
    }>('GET', `/v1/trackings/${encodeURIComponent(trackingId)}`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const base = this.config.get('BITESHIP_BASE_URL') ?? 'https://api.biteship.com';
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: this.config.getOrThrow('BITESHIP_API_KEY'),
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as T & { success?: boolean; error?: string };
    if (!res.ok || json.success === false) {
      this.logger.warn(`Biteship ${method} ${path} failed: ${res.status} ${json.error ?? ''}`);
      throw new BadGatewayException(json.error ?? 'Shipping service is unavailable');
    }
    return json;
  }
}
