package com.fason.app.features.gps.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface LocationDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(location: LocationEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(locations: List<LocationEntity>)

    // CHỐT QUAN TRỌNG: Chỉ lấy tối đa 50-100 record/lần để đẩy lên Server
    // Tránh load hàng triệu record lên RAM gây crash app (OutOfMemory)
    @Query("SELECT * FROM pending_locations ORDER BY timestamp ASC LIMIT :limit")
    suspend fun getPendingLocations(limit: Int = 50): List<LocationEntity>

    // Xóa hàng loạt cùng lúc sau khi đã đẩy thành công lên Server
    // Cách này nhanh hơn gấp nhiều lần so với việc gọi vòng for xóa từng id
    @Query("DELETE FROM pending_locations WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)

    @Query("DELETE FROM pending_locations")
    suspend fun deleteAll()

    @Query("SELECT COUNT(*) FROM pending_locations")
    suspend fun count(): Int
    
    // Lấy timestamp của record cũ nhất để biết offline bao lâu rồi
    @Query("SELECT MIN(timestamp) FROM pending_locations")
    suspend fun getOldestTimestamp(): Long?
}