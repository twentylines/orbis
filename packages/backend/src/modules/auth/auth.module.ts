import { EncryptionModule } from '@/core/encryption/encryption.module';
import { PasswordModule } from '@/core/password/password.module';
import { UserModule } from '@/modules/user/user.module';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionManager } from './session.manager';
import { PasskeyStore } from './passkey.store';
import { PasskeyService } from './passkey.service';

@Module({
  imports: [UserModule, EncryptionModule, PasswordModule],
  controllers: [AuthController],
  providers: [AuthService, SessionManager, PasskeyStore, PasskeyService],
  exports: [AuthService],
})
export class AuthModule {}
