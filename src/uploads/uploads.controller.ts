import {
  BadRequestException,
  Controller,
  Injectable,
  Module,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ResponseMessage } from '../common/decorators/message.decorator.js';

const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_DOCUMENTS = ['application/pdf', 'image/jpeg', 'image/png'];

@Injectable()
export class ImageKitService {
  constructor(private readonly config: ConfigService) {}

  /** Uploads via ImageKit REST API (basic auth with the private key). */
  async upload(file: Express.Multer.File) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
    form.append('fileName', file.originalname);
    form.append('folder', this.config.get('IMAGEKIT_FOLDER') ?? '/onlydeath');
    form.append('useUniqueFileName', 'true');

    const auth = Buffer.from(`${this.config.getOrThrow('IMAGEKIT_PRIVATE_KEY')}:`).toString('base64');
    const res = await fetch('https://upload.imagekit.io/api/v1/files/upload', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });
    const body = (await res.json()) as { url?: string; fileId?: string; message?: string };
    if (!res.ok || !body.url) {
      throw new BadRequestException(body.message ?? 'Upload failed');
    }
    return { url: body.url, file_id: body.fileId };
  }
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly imagekit: ImageKitService) {}

  @Post()
  @ResponseMessage('Image uploaded')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED.includes(file.mimetype)) {
      throw new BadRequestException('Image must be JPG, PNG or WEBP');
    }
    return this.imagekit.upload(file);
  }

  /** Shipping paperwork for manual international orders. */
  @Post('document')
  @ResponseMessage('Document uploaded')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE } }))
  uploadDocument(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_DOCUMENTS.includes(file.mimetype)) {
      throw new BadRequestException('Document must be PDF, JPG or PNG');
    }
    return this.imagekit.upload(file);
  }
}

@Module({
  controllers: [UploadsController],
  providers: [ImageKitService],
})
export class UploadsModule {}
